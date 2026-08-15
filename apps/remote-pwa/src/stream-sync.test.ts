import { describe, expect, it } from 'vitest'
import type { ControlEvent, EventPage } from '@dshpilot/control-contracts'
import { CURSOR_KEY, initialSyncState, loadCursor, reduceSync, saveCursor, type SyncCursor } from './stream-sync.js'

function page(generation: string, latestSeq: number, oldestSeq = 1, resetRequired = false): EventPage {
  return { generation, oldestSeq, latestSeq, resetRequired, events: [] }
}
function event(generation: string, seq: number): ControlEvent {
  return { protocolVersion: '1.0.0', generation, seq, eventId: `e${seq}`, type: 'assistant/message', at: new Date(0).toISOString(), payload: {} }
}

class MemoryStorage {
  private readonly store = new Map<string, string>()
  get length(): number { return this.store.size }
  clear(): void { this.store.clear() }
  getItem(key: string): string | null { return this.store.has(key) ? (this.store.get(key) as string) : null }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null }
  removeItem(key: string): void { this.store.delete(key) }
  setItem(key: string, value: string): void { this.store.set(key, String(value)) }
}

describe('DSHPilot Remote stream sync state machine', () => {
  it('starts idle with an empty cursor', () => {
    expect(initialSyncState).toMatchObject({ http: 'unknown', sse: 'idle', cursor: { generation: '', lastSeq: 0 } })
  })

  it('marks connecting on first dial and reconnecting after a drop', () => {
    const connecting = reduceSync(initialSyncState, { kind: 'stream-connecting' })
    expect(connecting.sse).toBe('connecting')
    const dropped = reduceSync({ ...connecting, sse: 'live' }, { kind: 'stream-error', message: 'boom' })
    expect(dropped.sse).toBe('reconnecting')
    expect(dropped.http).toBe('down')
    expect(dropped.note).toBe('boom')
  })

  it('treats a fresh generation snapshot as catching-up', () => {
    const next = reduceSync(initialSyncState, { kind: 'snapshot', page: page('gen-a', 10) })
    expect(next.sse).toBe('catching-up')
    expect(next.cursor).toEqual({ generation: 'gen-a', lastSeq: 10 })
  })

  it('flags a gap when the server jumped past the cursor', () => {
    const state = reduceSync(initialSyncState, { kind: 'snapshot', page: page('gen-a', 5) })
    const gap = reduceSync(state, { kind: 'snapshot', page: page('gen-a', 20) })
    expect(gap.sse).toBe('gap')
    expect(gap.note).toMatch(/missed 14 event/i)
    expect(gap.cursor.lastSeq).toBe(20)
  })

  it('flags a reset on generation mismatch or resetRequired', () => {
    const state = reduceSync(initialSyncState, { kind: 'snapshot', page: page('gen-a', 5) })
    const generationRolled = reduceSync(state, { kind: 'snapshot', page: page('gen-b', 2) })
    expect(generationRolled.sse).toBe('reset')
    expect(generationRolled.note).toMatch(/generation rolled/i)
    const serverReset = reduceSync(state, { kind: 'snapshot', page: page('gen-a', 9, 1, true) })
    expect(serverReset.sse).toBe('reset')
  })

  it('advances to live on contiguous events and ignores duplicates', () => {
    let state = reduceSync(initialSyncState, { kind: 'snapshot', page: page('gen-a', 3) })
    state = reduceSync(state, { kind: 'event', event: event('gen-a', 4) })
    expect(state.sse).toBe('live')
    expect(state.cursor.lastSeq).toBe(4)
    expect(state.note).toBeUndefined()
    const duplicate = reduceSync(state, { kind: 'event', event: event('gen-a', 3) })
    expect(duplicate).toBe(state) // unchanged reference for an already-seen event
    const gapEvent = reduceSync(state, { kind: 'event', event: event('gen-a', 7) })
    expect(gapEvent.sse).toBe('live')
    expect(gapEvent.note).toMatch(/missed 2 event/i)
  })

  it('resets when a live event arrives from a different generation', () => {
    const state = reduceSync(initialSyncState, { kind: 'snapshot', page: page('gen-a', 3) })
    const midStream = reduceSync(state, { kind: 'event', event: event('gen-b', 1) })
    expect(midStream.sse).toBe('reset')
    expect(midStream.cursor).toEqual({ generation: 'gen-b', lastSeq: 1 })
  })

  it('tracks HTTP reachability independently of the stream', () => {
    const up = reduceSync({ ...initialSyncState, sse: 'live' }, { kind: 'http-up' })
    expect(up.http).toBe('up')
    const down = reduceSync(up, { kind: 'http-down' })
    expect(down.http).toBe('down')
    expect(down.sse).toBe('live') // stream health is its own axis
  })
})

describe('DSHPilot Remote durable cursor persistence', () => {
  it('persists and reloads the cursor across a reload', () => {
    const storage = new MemoryStorage()
    const cursor: SyncCursor = { generation: 'gen-x', lastSeq: 42 }
    saveCursor(cursor, storage)
    expect(storage.getItem(CURSOR_KEY)).toBe(JSON.stringify(cursor))
    expect(loadCursor(storage)).toEqual(cursor)
  })

  it('returns an empty cursor when nothing is stored or storage is corrupt', () => {
    const storage = new MemoryStorage()
    expect(loadCursor(storage)).toEqual({ generation: '', lastSeq: 0 })
    storage.setItem(CURSOR_KEY, 'not-json')
    expect(loadCursor(storage)).toEqual({ generation: '', lastSeq: 0 })
    storage.setItem(CURSOR_KEY, JSON.stringify({ generation: 5, lastSeq: 'x' }))
    expect(loadCursor(storage)).toEqual({ generation: '', lastSeq: 0 })
  })
})
