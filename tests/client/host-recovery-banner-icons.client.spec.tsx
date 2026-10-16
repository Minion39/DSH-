// @vitest-environment jsdom
/**
 * #877, from the host's side.
 *
 * The banner named-imported `IconWarningOutline16` straight from the
 * primitives module. Host 0.2.1-alpha.1 renamed its icons to the weight
 * spellings and dropped …14/…16 (#670/#671), so that binding was `undefined`
 * and React threw while rendering the banner — the whole page went white, not
 * just the banner.
 *
 * This file mocks a host with exactly that export table and renders the real
 * component against it. The banner has to come up and say what it came to say;
 * a blank page is the failure this reproduces.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { createElement } = await import('react')
  // The published 0.1.7-alpha.1 export table (the same fixture icons.spec.ts
  // resolves against): every icon under its Regular/Medium spelling, and
  // nothing named …14/…16.
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const names = JSON.parse(readFileSync(join(fixtures, 'primitives-icons-0.1.7-alpha.1.json'), 'utf8')) as {
    icons: string[]
  }
  const mod: Record<string, unknown> = {}
  for (const name of names.icons) mod[name] = () => null
  // The components the market renders with. `Button` keeps its children: the
  // one click this banner offers lives inside it, and a stub that swallowed
  // them would hide the very thing under test.
  mod.Button = ({ children }: { children?: unknown }) => createElement('button', null, children)
  for (const name of ['Modal', 'Toast', 'Input', 'Menu', 'Pill', 'StateDot', 'DisclosureRow', 'Tooltip']) {
    mod[name] = () => null
  }
  return mod
})

import { HostRecoveryBanner } from '../../src/client/HostRecoveryBanner.tsx'

const t = (key: string): string => key

/** One backup of the size #875 lost, stamped the way the host stamps them. */
const VIEW = {
  patchName: 'cordis.patch.yml',
  currentBytes: 18,
  backups: [{ name: 'cordis.patch.yml.bak-1792065596554', stamp: 1_792_065_596_554, bytes: 22_679, rowIds: ['llm-pi-ai'] }],
  lostRowIds: ['llm-pi-ai'],
  offerRestore: true,
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => VIEW }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('HostRecoveryBanner on a host without …16 icons (#877)', () => {
  it('comes up and says what it came to say', async () => {
    render(h(HostRecoveryBanner, { t, bootId: 'boot-1' }))
    await waitFor(() => expect(screen.getByText('hostRecoveryTitle')).toBeTruthy())
    expect(screen.getByText('hostRecoveryRestore')).toBeTruthy()
  })
})
