/**
 * Host-compatibility guard: on hosts whose injected primitives module
 * predates rc.6, the named exports the market renders with are undefined
 * (the module itself resolves, so the bundle factory succeeds). apply()
 * must detect the gap and skip registration instead of throwing mid-render.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply, missingPrimitives, REQUIRED_PRIMITIVES } from '../../src/client/index.ts'
import { ICON_ALIASES, missingIcons } from '../../src/client/icons.ts'

describe('missingPrimitives', () => {
  it('reports no gaps when every required export exists', () => {
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    expect(missingPrimitives(mod)).toEqual([])
  })

  it('names the missing exports on an old host', () => {
    const mod: Record<string, unknown> = { Menu: () => null, Toast: () => null }
    expect(missingPrimitives(mod)).toEqual(['DisclosureRow', 'Tooltip'])
  })

  it('reports every requirement when the module is empty', () => {
    expect(missingPrimitives({})).toEqual([...REQUIRED_PRIMITIVES])
  })

  it('accepts a custom requirement list', () => {
    expect(missingPrimitives({ A: 1 }, ['A', 'B', 'C'])).toEqual(['B', 'C'])
  })
})

describe('apply() icon gaps (#671)', () => {
  it('treats a 0.1.7-only Regular icon table as complete for missingIcons', () => {
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    for (const [, newer] of ICON_ALIASES) mod[newer] = () => null
    expect(missingPrimitives(mod)).toEqual([])
    expect(missingIcons(mod)).toEqual([])
  })

  it('does not treat icon gaps as a hard apply() disable', () => {
    // Missing Menu still disables; missing icons alone must not — icons.ts
    // skips the glyph so a rename costs one icon, not the settings page.
    const mod: Record<string, unknown> = {}
    for (const name of REQUIRED_PRIMITIVES) mod[name] = () => null
    expect(missingPrimitives(mod)).toEqual([])
    expect(missingIcons(mod).length).toBeGreaterThan(0)
  })
})

/** A host that declares only the slots it has, and records what the market did. */
function hostWith(declared: readonly string[]) {
  const registrations: Record<string, unknown>[] = []
  const injections: string[][] = []
  const slots = new Set(declared)
  apply({
    effect: (run: () => unknown) => { run() },
    on: () => () => {},
    locale: {
      register: () => () => {}, bind: () => (key: string) => key,
      subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
    },
    theme: { getTheme: () => null, setTheme: () => {} },
    slots: {
      // A real host fires this only for the slots it declares — which is what
      // makes the slot itself the feature detection for the newer card seat.
      inject: (slot: string, register: () => unknown) => { if (slots.has(slot)) register() },
      register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
    },
    // The service injections are RECORDED but never fired on this host: that
    // is the "host without settingsScope" case the market must survive.
    inject: (services: string[]) => { injections.push(services) },
  } as Parameters<typeof apply>[0])
  return { registrations: registrations.map(entry => entry.name), injections }
}

it('keeps the main market on hosts without settingsScope (#516)', () => {
  const { registrations, injections } = hostWith(['settings.section', 'shell.overlay'])
  expect(injections).toEqual([['settingsScope']])
  expect(registrations).toEqual(['settings.section', 'shell.overlay'])
})

it('offers the market as a Plugins-page tab on the line that declares one (#722)', () => {
  // 0.1.7 removed `settingsScope` and `settings.plugin.item`, and no host
  // declares `plugins.bundle.config` — so the card had no seat on that line at
  // all and vanished silently. The tab slot is what its contract offers for a
  // page inside the Plugins section, and it is the one the market must follow.
  const { registrations, injections } = hostWith(['settings.section', 'shell.overlay', 'settings.plugins.tab'])
  expect(injections).toEqual([['settingsScope']])
  expect(registrations).toEqual(['settings.section', 'settings.plugins.tab', 'shell.overlay'])
})

it('places the settings card on the bundle page a 0.1.7 host declares (#677)', () => {
  // The newer line has no plugin-configuration page and no settingsScope; it
  // declares `plugins.bundle.config`, which its own contract names as where a
  // third-party bundle's configuration belongs. The card must follow the
  // slot, and the market must still register everything else.
  const { registrations, injections } = hostWith(['settings.section', 'shell.overlay', 'plugins.bundle.config'])
  expect(injections).toEqual([['settingsScope']])
  expect(registrations).toEqual(['settings.section', 'plugins.bundle.config', 'shell.overlay'])
})

/**
 * #869: the loader runs a client plugin's factory on the boot path, so a
 * throw inside apply() is a throw inside the shell's own bootstrap and takes
 * the whole app down (reported on the Desktop shell). Whatever the cause
 * turns out to be, the market hosting itself in someone else's app must not
 * be able to kill it.
 */
describe('apply() contains a throw from the host (#869)', () => {
  /** A host whose registration of the market's main section throws. */
  function hostWhoseSectionRegistrationThrows() {
    return {
      effect: (run: () => unknown) => { run() },
      on: () => () => {},
      locale: {
        register: () => () => {}, bind: () => (key: string) => key,
        subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }),
      },
      theme: { getTheme: () => null, setTheme: () => {} },
      slots: {
        inject: (slot: string, register: () => unknown) => { if (slot === 'settings.section') register() },
        register: (options: Record<string, unknown>) => {
          if (options.name === 'settings.section') throw new Error('host refused the section')
          return () => {}
        },
      },
      inject: () => {},
    } as Parameters<typeof apply>[0]
  }

  it('does not let the throw escape into the shell, and says so on the console', () => {
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) })
    try {
      expect(() => apply(hostWhoseSectionRegistrationThrows())).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain('[dsh-market] mounting failed')
    // The error object rides along so the console holds the stack, not just
    // a sentence about it.
    expect(logged[0][1]).toBeInstanceOf(Error)
  })

  it('contains a throw from any mount point, not just the first one that fires', () => {
    // Containment is the outer try/catch, so a failure while mounting the
    // overlay toast is caught exactly like the section's. If this ever moves
    // to per-call guards, this test is what fails.
    const host = hostWhoseSectionRegistrationThrows()
    const slots = host.slots as {
      inject: (slot: string, register: () => unknown) => void
      register: (options: Record<string, unknown>) => unknown
    }
    slots.inject = (slot: string, register: () => unknown) => {
      if (slot === 'shell.overlay') register()
    }
    slots.register = () => { throw new Error('host refused the overlay') }

    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) })
    try {
      expect(() => apply(host)).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).toContain('[dsh-market] mounting failed')
  })
})

/**
 * The one icon mistake that blanks the entire page (#877).
 *
 * An icon named-imported from the primitives module is a bet on that exact
 * export existing on the host, and neither `missingIcons` nor `apply()` can
 * see it: the import is resolved by the bundler, so a host that renamed its
 * icons leaves the binding `undefined` and React throws while rendering the
 * component — the whole page goes white, not just the part that wanted the
 * glyph. (The reporter's stack shows the throw escaping even the market's own
 * boundary, because it happens during the first render of a tree the boundary
 * has not yet mounted.)
 *
 * #877 was exactly that: `HostRecoveryBanner` imported `IconWarningOutline16`,
 * which host 0.2.1-alpha.1 no longer ships (…14/…16 → …Regular, #670/#671).
 *
 * Icons therefore come from `./icons.ts`, whose alias table picks the name the
 * host actually has and falls back to nothing when it has neither. The
 * primitives module is for components (Button, Modal, …) — those are declared
 * in REQUIRED_PRIMITIVES, and `missingPrimitives` disables the page on purpose.
 */
describe('no icon is named-imported from the primitives module (#877)', () => {
  const CLIENT = join(__dirname, '..', '..', 'src', 'client')

  it('resolves every icon through the alias table instead', () => {
    const offenders: string[] = []
    for (const name of readdirSync(CLIENT).filter(entry => /\.tsx?$/.test(entry))) {
      const text = readFileSync(join(CLIENT, name), 'utf8')
      for (const [, bindings] of text.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/g,
      )) {
        for (const raw of (bindings ?? '').split(',')) {
          const binding = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()
          // `IconProps` is a type; every other name starting with Icon is a glyph.
          if (binding !== 'IconProps' && /^Icon[A-Z]/.test(binding)) offenders.push(`${name}: ${binding}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
