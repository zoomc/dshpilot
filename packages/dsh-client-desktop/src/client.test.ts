import { describe, expect, it } from 'vitest'
import { apply } from './client.js'

describe('DSHPilot Client Harness slot seam', () => {
  it('loads through the official composer dock and disposes its registration', () => {
    const registrations: Array<{ name?: unknown; id?: unknown }> = []
    let injectionDisposer: (() => void) | undefined
    const ctx = {
      slots: {
        inject(key: string, setup: () => unknown): unknown { expect(key).toBe('conversation.composer.dock'); injectionDisposer = setup() as (() => void); return injectionDisposer },
        register(options: Record<string, unknown>): () => void { registrations.push(options); return () => { registrations.splice(registrations.indexOf(options), 1) } },
      },
    }
    apply(ctx)
    expect(registrations).toEqual([{ name: 'conversation.composer.dock', id: 'dshpilot-status', order: 200, label: 'DSHPilot' }])
    injectionDisposer?.()
    expect(registrations).toHaveLength(0)
  })
})
