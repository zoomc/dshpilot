import { describe, expect, it, vi, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as React from 'react'
import { apply, inject, name, plugin } from './client.js'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientBundlePath = resolve(pkgRoot, 'lib', 'client.js')

describe('DSHPilot Client Harness slot seam', () => {
  it('loads through the official composer dock and disposes its registration', () => {
    const registrations: Array<{ name?: unknown; id?: unknown }> = []
    const injectionDisposers: Array<() => void> = []
    const ctx = {
      slots: {
        inject(key: string, setup: () => unknown): unknown {
          expect(['conversation.composer.dock', 'sidebar.footer.action', 'settings.section']).toContain(key)
          const disposer = setup() as (() => void)
          injectionDisposers.push(disposer)
          return disposer
        },
        register(options: Record<string, unknown>): () => void {
          registrations.push(options)
          return () => { registrations.splice(registrations.indexOf(options), 1) }
        },
      },
    }
    apply(ctx)
    expect(registrations).toEqual(expect.arrayContaining([
      { name: 'conversation.composer.dock', id: 'dshpilot-status', order: 200, label: 'DSHPilot' },
      { name: 'sidebar.footer.action', id: 'dshpilot-update', order: 50, label: 'DSHPilot Update' },
      { name: 'settings.section', id: 'dshpilot-remote', order: 50, label: '远程控制' },
      { name: 'settings.section', id: 'dshpilot-mcp', order: 51, label: 'MCP 管理' },
      { name: 'settings.section', id: 'dshpilot-tokens', order: 52, label: 'Token 统计' },
      { name: 'settings.section', id: 'dshpilot-update', order: 53, label: '检查更新' },
    ]))
    for (const disposer of injectionDisposers) disposer()
    expect(registrations).toHaveLength(0)
  })

  it('exposes the Cordis plugin surface as named and default exports', () => {
    expect(name).toBe('dshpilot-client')
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain('slots')
    expect(typeof apply).toBe('function')
    expect(plugin).toMatchObject({ name: 'dshpilot-client', inject: expect.arrayContaining(['slots']), apply })
  })
})

describe('DSHPilot Client official loader contract (built CJS bundle)', () => {
  // The real Harness web-shell contract: the tsdown bundle wraps the module in
  // `window.__ModuleLoader__.load({ id, factory })`. This exercises the ACTUAL
  // built artifact (not the source) so a regression to the ESM/loader format
  // fails here instead of only at runtime in the WebView.
  beforeAll(() => {
    execSync('pnpm build', { cwd: pkgRoot, stdio: 'inherit' })
  }, 120_000)

  it('registers through window.__ModuleLoader__ and applies the official slots', async () => {
    const sink = { load: vi.fn() }
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: sink,
      __TAURI__: {},
      __TAURI_INTERNALS__: {},
    }
    try {
      await import(clientBundlePath)
      expect(sink.load).toHaveBeenCalledTimes(1)
      const handoff = sink.load.mock.calls[0]![0] as {
        id: string
        factory: (require: (id: string) => unknown) => { name: string; inject: string[]; apply: (ctx: unknown) => void }
      }
      expect(handoff.id).toBe('@dshpilot/dsh-client-desktop')
      // The loader resolves externals (react, platform seeds) from its module
      // table; emulate that here so the factory can evaluate.
      const loaded = handoff.factory((id: string) => (id === 'react' ? React : {}))
      expect(loaded.name).toBe('dshpilot-client')
      expect(loaded.inject).toContain('slots')
      expect(typeof loaded.apply).toBe('function')

      const registrations: Array<Record<string, unknown>> = []
      loaded.apply({
        slots: {
          inject: (_key: string, setup: () => unknown) => setup(),
          register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
        },
      })
      expect(registrations.some(value => value.id === 'dshpilot-status')).toBe(true)
      expect(registrations.some(value => value.id === 'dshpilot-update')).toBe(true)
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})
