import { describe, expect, it, vi } from 'vitest'
import clientModule, { apply, inject, name, plugin } from './client.js'

describe('DSHPilot Client Harness slot seam', () => {
  it('loads through the official composer dock and disposes its registration', () => {
    const registrations: Array<{ name?: unknown; id?: unknown }> = []
    const injectionDisposers: Array<() => void> = []
    const ctx = {
      slots: {
        inject(key: string, setup: () => unknown): unknown { expect(['conversation.composer.dock', 'sidebar.footer.action']).toContain(key); const disposer = setup() as (() => void); injectionDisposers.push(disposer); return disposer },
        register(options: Record<string, unknown>): () => void { registrations.push(options); return () => { registrations.splice(registrations.indexOf(options), 1) } },
      },
    }
    apply(ctx)
    expect(registrations).toEqual(expect.arrayContaining([
      { name: 'conversation.composer.dock', id: 'dshpilot-status', order: 200, label: 'DSHPilot' },
      { name: 'sidebar.footer.action', id: 'dshpilot-update', order: 50, label: 'DSHPilot Update' },
    ]))
    for (const disposer of injectionDisposers) disposer()
    expect(registrations).toHaveLength(0)
  })
})

describe('DSHPilot Client official loader contract', () => {
  it('exports the Cordis plugin surface as named and default exports', () => {
    expect(name).toBe('dshpilot-client')
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain('slots')
    expect(typeof apply).toBe('function')
    // The default export must be the same surface object the harness loads.
    expect(clientModule).toBe(plugin)
    expect(clientModule).toMatchObject({ name: 'dshpilot-client', inject: expect.arrayContaining(['slots']), apply })
  })

  it('registers the surface through the Harness web-shell ModuleLoader sink when present', async () => {
    const previous = (globalThis as { window?: unknown }).window
    const sink = { load: vi.fn() }
    ;(globalThis as { window?: unknown }).window = { __ModuleLoader__: sink }
    try {
      vi.resetModules()
      const reloaded = await import('./client.js')
      expect(sink.load).toHaveBeenCalledTimes(1)
      const handoff = sink.load.mock.calls[0]![0] as { id: string; factory: () => unknown }
      expect(handoff.id).toBe('@dshpilot/dsh-client-desktop')
      expect(handoff.factory()).toMatchObject({ name: 'dshpilot-client', inject: expect.arrayContaining(['slots']), apply: reloaded.apply })
    } finally {
      ;(globalThis as { window?: unknown }).window = previous
      vi.resetModules()
    }
  })
})

