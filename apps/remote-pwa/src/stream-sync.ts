import type { ControlEvent, EventPage } from '@dshpilot/control-contracts'

/** HTTP control-plane reachability. Tracked separately from the SSE stream so
 *  a transient stream blip never masquerades as a dead server, and a server
 *  outage never hides a healthy local stream. */
export type HttpStatus = 'unknown' | 'up' | 'down'

/**
 * SSE event-stream lifecycle:
 * - `idle`: never connected.
 * - `connecting`: first connection attempt.
 * - `reconnecting`: a previously-live stream dropped and we are dialing again.
 * - `catching-up`: a snapshot landed, projection is converging to live.
 * - `live`: contiguous events are arriving.
 * - `gap`: the server advanced past our cursor (events were missed).
 * - `reset`: the generation rolled (server restart) and the old cursor is invalid.
 */
export type SseStatus = 'idle' | 'connecting' | 'reconnecting' | 'catching-up' | 'live' | 'gap' | 'reset'

export interface SyncCursor {
  /** Durable generation id; a mismatch vs. the server means a full restart. */
  generation: string
  /** Highest contiguous event sequence consumed this generation. */
  lastSeq: number
}

export interface SyncState {
  http: HttpStatus
  sse: SseStatus
  cursor: SyncCursor
  /** Operator-facing note (e.g. "missed N events"), cleared once live. */
  note?: string
}

export const initialSyncState: SyncState = { http: 'unknown', sse: 'idle', cursor: { generation: '', lastSeq: 0 } }

export type SyncInput =
  | { kind: 'http-up' }
  | { kind: 'http-down' }
  | { kind: 'stream-connecting' }
  | { kind: 'snapshot'; page: EventPage }
  | { kind: 'event'; event: ControlEvent }
  | { kind: 'stream-error'; message?: string }

/** Pure reducer for the reconnect / catch-up / gap / reset state machine. */
export function reduceSync(state: SyncState, input: SyncInput): SyncState {
  switch (input.kind) {
    case 'http-up':
      return { ...state, http: 'up' }
    case 'http-down':
      return { ...state, http: 'down' }
    case 'stream-connecting':
      return { ...state, sse: state.sse === 'idle' ? 'connecting' : 'reconnecting' }
    case 'stream-error':
      return { ...state, http: 'down', sse: 'reconnecting', note: input.message }
    case 'snapshot': {
      const { page } = input
      const generationChanged = state.cursor.generation !== '' && page.generation !== state.cursor.generation
      const reset = generationChanged || page.resetRequired
      if (reset) {
        return {
          http: 'up',
          sse: 'reset',
          cursor: { generation: page.generation, lastSeq: page.latestSeq },
          note: generationChanged ? 'generation rolled — cursor reset' : 'server requested a full reset',
        }
      }
      const gap = state.cursor.generation !== '' && page.latestSeq > state.cursor.lastSeq + 1
      if (gap) {
        const missed = page.latestSeq - state.cursor.lastSeq - 1
        return {
          http: 'up',
          sse: 'gap',
          cursor: { generation: page.generation, lastSeq: page.latestSeq },
          note: `missed ${missed} event(s) before reconnect`,
        }
      }
      return { http: 'up', sse: 'catching-up', cursor: { generation: page.generation, lastSeq: page.latestSeq } }
    }
    case 'event': {
      const { event } = input
      if (event.generation !== state.cursor.generation) {
        return {
          ...state,
          sse: 'reset',
          cursor: { generation: event.generation, lastSeq: event.seq },
          note: 'generation rolled mid-stream — resync required',
        }
      }
      if (event.seq <= state.cursor.lastSeq) return state // duplicate or already-seen event
      const gap = event.seq > state.cursor.lastSeq + 1
      if (gap) {
        const missed = event.seq - state.cursor.lastSeq - 1
        return { ...state, sse: 'live', cursor: { generation: event.generation, lastSeq: event.seq }, note: `missed ${missed} event(s)` }
      }
      return { ...state, sse: 'live', cursor: { generation: event.generation, lastSeq: event.seq }, note: undefined }
    }
  }
}

export const CURSOR_KEY = 'dshpilot.remote.cursor'

/** Load the persisted cursor; never throws (best-effort offline cache). */
export function loadCursor(storage: Storage = globalThis.localStorage): SyncCursor {
  try {
    const raw = storage.getItem(CURSOR_KEY)
    if (raw === null) return { generation: '', lastSeq: 0 }
    const parsed = JSON.parse(raw) as Partial<SyncCursor>
    if (typeof parsed.generation === 'string' && Number.isInteger(parsed.lastSeq) && (parsed.lastSeq as number) >= 0) {
      return { generation: parsed.generation, lastSeq: parsed.lastSeq as number }
    }
    return { generation: '', lastSeq: 0 }
  } catch {
    return { generation: '', lastSeq: 0 }
  }
}

/** Persist the cursor; never throws (best-effort offline cache). */
export function saveCursor(cursor: SyncCursor, storage: Storage = globalThis.localStorage): void {
  try {
    storage.setItem(CURSOR_KEY, JSON.stringify(cursor))
  } catch {
    /* offline cache is best effort and never blocks remote control */
  }
}
