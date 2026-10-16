import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOfficialDesktopRuntime, type OfficialPluginManagerLike } from '../src/official-desktop.ts'
import { withHoistRecovery } from '../src/install.ts'
import { routesFor, setActiveRegion } from '../src/regions.ts'

const roots: string[] = []

beforeEach(() => {
  vi.stubEnv('DSHM_NPM_MIRROR', '')
  setActiveRegion('global')
})

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-official-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0', gitplug: 'github:o/r' } }))
  return dir
}

afterEach(() => {
  setActiveRegion('global')
  vi.unstubAllEnvs()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manager(): OfficialPluginManagerLike & {
  installBundle: ReturnType<typeof vi.fn>
  removeBundle: ReturnType<typeof vi.fn>
  cancelInstall: ReturnType<typeof vi.fn>
} {
  return {
    installBundle: vi.fn(async () => ({ application: 'restart-required', packageResult: { exitCode: 0, output: 'installed' } })),
    removeBundle: vi.fn(async () => ({ application: 'applied', packageResult: { exitCode: 0, output: 'removed' } })),
    cancelInstall: vi.fn(async () => ({ status: 'cancelled' })),
  }
}

describe('official Electron profile runtime', () => {
  it('merges exclusions appended by a successful manager install before returning (#883, #878)', async () => {
    const dir = profile()
    const workspace = join(dir, 'pnpm-workspace.yaml')
    const initial = 'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - example@1.0.0\n'
    writeFileSync(workspace, initial)
    const service = manager()
    service.installBundle.mockImplementationOnce(async () => {
      writeFileSync(workspace, `${initial}  - example@2.0.0\n`)
      return { application: 'restart-required', packageResult: { exitCode: 0, output: 'installed' } }
    })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', dir)
    try {
      const result = await withHoistRecovery(runtime.runPlugin, 'desktop', ['add', 'example@2.0.0'], dir, { marketFlags: false })
      expect(result).toMatchObject({ exitCode: 0, stdout: 'installed', cancelled: false, timedOut: false })
      expect(readFileSync(workspace, 'utf8')).toBe(initial.replace('example@1.0.0', 'example@1.0.0 || 2.0.0'))
      expect(service.installBundle).toHaveBeenCalledTimes(1)
      expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
    } finally {
      await runtime.dispose()
    }
  })

  it('installs through the in-process manager and never the CLI', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['add', 'example@2.0.0'])).resolves.toMatchObject({ exitCode: 0, stdout: 'installed' })
    expect(service.installBundle).toHaveBeenCalledWith('example@2.0.0', { requestId: expect.any(String) })
    await runtime.dispose()
  })

  it('uses the current market mirror for installs, update targets and exact rollback targets (#862)', async () => {
    setActiveRegion('china')
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    for (const target of ['example', 'example@2.0.0', 'example@1.0.0']) {
      await expect(runtime.runPlugin('desktop', ['add', target])).resolves.toMatchObject({ exitCode: 0 })
      expect(service.installBundle).toHaveBeenLastCalledWith(target, {
        requestId: expect.any(String), registry: routesFor('china', {}).npmRegistry,
      })
    }
    await runtime.dispose()
  })

  it('applies region switches to the next install without recreating the runtime (#862)', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    for (const region of ['global', 'china', 'global', 'china'] as const) {
      setActiveRegion(region)
      await runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
      expect(service.installBundle).toHaveBeenLastCalledWith('example@2.0.0', {
        requestId: expect.any(String),
        ...(region === 'global' ? {} : { registry: routesFor(region, {}).npmRegistry }),
      })
    }
    await runtime.dispose()
  })

  it('uses the same npm mirror override as market requests (#862)', async () => {
    setActiveRegion('china')
    vi.stubEnv('DSHM_NPM_MIRROR', 'https://npm.example.test/custom/')
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await runtime.runPlugin('desktop', ['add', '@scope/example@2.0.0'])
    expect(service.installBundle).toHaveBeenCalledWith('@scope/example@2.0.0', {
      requestId: expect.any(String), registry: 'https://npm.example.test/custom',
    })
    await runtime.dispose()
  })

  it('keeps removal and cancellation on their existing manager APIs with a mirror selected', async () => {
    setActiveRegion('china')
    const service = manager()
    let finish!: (result: { application: string }) => void
    service.installBundle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    const installing = runtime.runPlugin('desktop', ['add', 'example@2.0.0'])
    const options = service.installBundle.mock.calls[0]![1] as { requestId: string }
    expect(options.requestId).toEqual(expect.any(String))
    expect(runtime.cancelActive()).toBe(true)
    expect(service.cancelInstall).toHaveBeenCalledWith(options.requestId)
    finish({ application: 'cancelled' })
    await expect(installing).resolves.toMatchObject({ exitCode: 1, cancelled: true })
    await expect(runtime.runPlugin('desktop', ['remove', 'example'])).resolves.toMatchObject({ exitCode: 0 })
    expect(service.removeBundle).toHaveBeenCalledWith('example')
    expect(service.removeBundle.mock.calls[0]).toEqual(['example'])
    expect(runtime.cancelActive()).toBe(false)
    await runtime.dispose()
  })

  it('refuses another profile, absent service, and unsupported pnpm flags', async () => {
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    // The capability the route layer reads to stop decorating commands with
    // options this host refuses (#732).
    expect(runtime.acceptsMarketPnpmFlags).toBe(false)
    await expect(runtime.runPlugin('web', ['add', 'example'])).resolves.toMatchObject({ exitCode: 127 })
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example'])).resolves.toMatchObject({ exitCode: 127 })
    // The OPERATION is supported; only the option is not — and the message
    // has to say which, or the user goes looking for a broken profile (#732).
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example']))
      .resolves.toMatchObject({ exitCode: 127, stderr: expect.stringContaining('--force') })
    await expect(runtime.runPlugin('desktop', ['add', '--force', 'example']))
      .resolves.not.toMatchObject({ stderr: expect.stringContaining('this desktop operation is not supported') })
    await expect(runtime.runPlugin('desktop', ['install'])).resolves.toMatchObject({ exitCode: 127 })
    expect(service.installBundle).not.toHaveBeenCalled()
    const missing = createOfficialDesktopRuntime(() => undefined, 'desktop', profile())
    // Absent service: a message the user can act on, pointing at the app's
    // own Plugins page — never the CLI, which refuses this profile by name.
    await expect(missing.runPlugin('desktop', ['add', 'example'])).resolves.toMatchObject({ exitCode: 127, stderr: expect.stringContaining('Settings → Plugins') })
  })

  it('refuses `update` rather than rewriting it to name@latest, and removes through the manager', async () => {
    // `update` reaches a runtime only for #564's in-place re-resolve of a
    // floating git spec. `name@latest` would cross the installed range and
    // ignore the release channel — a different operation — so it is refused
    // with the pointer to the official page instead.
    const service = manager()
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['update', 'example'])).resolves.toMatchObject({ exitCode: 127, stderr: expect.stringContaining('Settings → Plugins') })
    expect(service.installBundle).not.toHaveBeenCalled()
    await expect(runtime.runPlugin('desktop', ['remove', 'example'])).resolves.toMatchObject({ exitCode: 0 })
    expect(service.removeBundle).toHaveBeenCalledWith('example')
  })

  it('never reports exit 0 for a failed application, even after a successful pnpm step', async () => {
    // The official ChangeResult: "successful installation can proceed to
    // enablement" — so stage `enable` + application `failed` follows a pnpm
    // run that EXITED 0. Taking packageResult.exitCode there reported the
    // failed enablement as a successful install; every route reads exit 0
    // as success.
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', stage: 'enable', changed: true, error: 'entry failed to start', packageResult: { exitCode: 0, output: 'Done' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    const result = await runtime.runPlugin('desktop', ['add', 'example'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBe('entry failed to start')
  })

  it('treats `overridden` as a kept change, not a failure', async () => {
    // `changed: true`: the manager persisted it, and a user patch decides
    // whether it runs. Calling that a failure sent the update route into a
    // rollback of a change the manager had kept.
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'overridden', stage: 'enable', changed: true, packageResult: { exitCode: 0, output: 'Done' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    const result = await runtime.runPlugin('desktop', ['add', 'example'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('another layer overrides')
  })

  it('maps manager failure without reporting success', async () => {
    const service = manager()
    service.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'network' }, packageResult: { exitCode: 1, output: '' } })
    const runtime = createOfficialDesktopRuntime(() => service, 'desktop', profile())
    await expect(runtime.runPlugin('desktop', ['add', 'example'])).resolves.toMatchObject({ exitCode: 1, stderr: '{"code":"network"}' })
  })
})
