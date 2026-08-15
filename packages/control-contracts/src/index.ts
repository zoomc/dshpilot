export const CONTROL_PROTOCOL_VERSION = 1 as const

export type ControlScope = 'read' | 'control' | 'admin'
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'restarting' | 'failed'
export type ControlEventType =
  | 'server.connected'
  | 'server.disconnected'
  | 'runtime.starting'
  | 'runtime.ready'
  | 'runtime.failed'
  | 'runtime.restarting'
  | 'runtime.stopped'
  | 'harness.ready'
  | 'harness.exit'
  | 'permission.requested'
  | 'permission.resolved'
  | 'mcp.changed'
  | 'document.changed'
  | 'notification.emitted'
  | 'task.updated'
  | 'notification.created'
  | 'device.paired'
  | 'device.revoked'
  | 'prompt.accepted'
  | 'prompt.rejected'

export interface ServerInfo {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  serverId: string
  name: string
  version: string
  capabilities: readonly string[]
  remoteEnabled: boolean
  loopbackOnly: boolean
  publicKey?: string
}

export interface RuntimeStatus {
  state: RuntimeState
  runtimeVersion?: string
  upstreamSha?: string
  url?: string
  pid?: number
  restartCount: number
  lastError?: string
}

export interface SessionSummary {
  sessionId: string
  title?: string
  cwd?: string
  status: 'idle' | 'running' | 'waiting' | 'failed' | 'closed'
  updatedAt: string
}

export interface TaskSummary {
  taskId: string
  sessionId?: string
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  title?: string
  updatedAt: string
}

export interface PermissionSummary {
  permissionId: string
  sessionId?: string
  tool?: string
  description?: string
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  createdAt: string
  updatedAt: string
}

export interface DeviceInfo {
  deviceId: string
  name: string
  scopes: readonly ControlScope[]
  createdAt: string
  lastSeenAt?: string
  revokedAt?: string
  accessExpiresAt?: string
  refreshExpiresAt?: string
}

export interface PairingOffer {
  schemaVersion: 1
  offerId: string
  serverId: string
  publicKey: string
  code: string
  nonce: string
  expiresAt: string
  relayEndpoint?: string
}

export interface ControlEvent<TPayload = Record<string, unknown>> {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  generation: string
  seq: number
  eventId: string
  type: ControlEventType
  at: string
  payload: TPayload
}

export interface EventPage {
  generation: string
  oldestSeq: number
  latestSeq: number
  resetRequired: boolean
  events: ControlEvent[]
}

export interface PromptAdmissionRequest {
  kind: 'prompt_admission'
  requestId: string
  sessionId?: string
  input: string
  cwd?: string
  clientId?: string
}

export type ControlRequest =
  | { kind: 'server_info' }
  | { kind: 'runtime_status' }
  | { kind: 'session_list' }
  | { kind: 'task_list' }
  | { kind: 'events'; after?: number; limit?: number }
  | PromptAdmissionRequest
  | { kind: 'interrupt'; requestId: string; sessionId: string }
  | { kind: 'permission_list'; sessionId?: string }
  | { kind: 'permission_reply'; requestId: string; permissionId: string; decision: 'allow' | 'deny' }
  | { kind: 'device_list' }
  | { kind: 'device_revoke'; deviceId: string }
  | { kind: 'device_rotate'; deviceId: string }

export interface ControlSuccess<T = unknown> {
  ok: true
  requestId?: string
  value: T
}

export interface ControlFailure {
  ok: false
  requestId?: string
  error: { code: string; message: string; retryable?: boolean }
}

export type ControlResponse<T = unknown> = ControlSuccess<T> | ControlFailure

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('requestId must be a bounded identifier')
}

export function assertControlRequest(value: unknown): asserts value is ControlRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('control request must be an object')
  const request = value as Record<string, unknown>
  if (typeof request.kind !== 'string') throw new Error('control request kind is required')
  if (request.kind === 'prompt_admission') {
    assertRequestId(request.requestId)
    if (typeof request.input !== 'string' || request.input.length === 0 || request.input.length > 128_000) throw new Error('prompt input is invalid')
    if (request.sessionId !== undefined && (typeof request.sessionId !== 'string' || !ID.test(request.sessionId))) throw new Error('sessionId is invalid')
    if (request.cwd !== undefined && (typeof request.cwd !== 'string' || request.cwd.length > 4_096)) throw new Error('cwd is invalid')
    if (request.clientId !== undefined && (typeof request.clientId !== 'string' || !ID.test(request.clientId))) throw new Error('clientId is invalid')
    return
  }
  if (request.kind === 'interrupt' || request.kind === 'permission_reply') assertRequestId(request.requestId)
  if (request.kind === 'interrupt' && (typeof request.sessionId !== 'string' || !ID.test(request.sessionId))) throw new Error('sessionId is invalid')
  if (request.kind === 'permission_list' && request.sessionId !== undefined && (typeof request.sessionId !== 'string' || !ID.test(request.sessionId))) throw new Error('sessionId is invalid')
  if (request.kind === 'permission_reply') {
    if (typeof request.permissionId !== 'string' || !ID.test(request.permissionId)) throw new Error('permissionId is invalid')
    if (request.decision !== 'allow' && request.decision !== 'deny') throw new Error('permission decision is invalid')
  }
  if (request.kind === 'device_revoke' && (typeof request.deviceId !== 'string' || !ID.test(request.deviceId))) throw new Error('deviceId is invalid')
  if (request.kind === 'device_rotate' && (typeof request.deviceId !== 'string' || !ID.test(request.deviceId))) throw new Error('deviceId is invalid')
  if (!['server_info', 'runtime_status', 'session_list', 'task_list', 'events', 'prompt_admission', 'interrupt', 'permission_list', 'permission_reply', 'device_list', 'device_revoke', 'device_rotate'].includes(request.kind)) throw new Error(`unsupported control request: ${request.kind}`)
}

export function parseControlRequest(text: string): ControlRequest {
  const value: unknown = JSON.parse(text)
  assertControlRequest(value)
  return value
}

export function assertControlEvent(value: unknown): asserts value is ControlEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('control event must be an object')
  const event = value as Partial<ControlEvent>
  if (event.protocolVersion !== CONTROL_PROTOCOL_VERSION || typeof event.generation !== 'string' || !ID.test(event.generation) || !Number.isSafeInteger(event.seq) || (event.seq ?? 0) < 1) throw new Error('invalid control event version or sequence')
  if (typeof event.eventId !== 'string' || !ID.test(event.eventId)) throw new Error('invalid control event id')
  if (typeof event.type !== 'string' || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) throw new Error('invalid control event metadata')
}

export function parseControlEvent(text: string): ControlEvent {
  const value: unknown = JSON.parse(text)
  assertControlEvent(value)
  return value
}
