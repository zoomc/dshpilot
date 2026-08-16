import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual, type KeyObject } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  assertControlRequest, CONTROL_PROTOCOL_VERSION, type ControlEvent, type ControlEventType, type ControlRequest, type DevicePairingRequest,
  type ControlResponse, type ControlScope, type DeviceInfo, type PairingOffer, type RuntimeStatus, type ServerInfo,
  type EventPage, type SessionSummary, type TaskSummary, type PermissionSummary,
} from '@dshpilot/control-contracts'
export * from './relay.js'
export * from './relay-tunnel.js'
import { RelayRouter, signRelayReady, verifyPairingProof, verifyRelayHandshake, type EncryptedRelayFrame, type RelayHandshake, type RelayHandshakeExpectations, type RelayIdentity } from './relay.js'

interface EventStoreOptions { filePath?: string; maxEvents?: number; maxFileBytes?: number }

export class DurableEventStore {
  private readonly events: ControlEvent[] = []
  private readonly maxEvents: number
  private readonly maxFileBytes: number
  private readonly filePath?: string
  generation: string = randomUUID()
  private writeChain: Promise<void> = Promise.resolve()
  private readonly subscribers = new Set<(event: ControlEvent) => void>()
  private sequence = 0

  constructor(options: EventStoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? 10_000
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
    this.filePath = options.filePath
  }

  async load(): Promise<void> {
    if (this.filePath === undefined) return
    let persistedGeneration = false
    try {
      try {
        const value = (await readFile(`${this.filePath}.generation`, 'utf8')).trim()
        if (value) { this.generation = value; persistedGeneration = true }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean)
      for (const line of lines) {
        const event = redactLegacyEvent(JSON.parse(line) as ControlEvent)
        if (!Number.isSafeInteger(event.seq) || event.seq <= this.sequence) throw new Error('event log sequence is not strictly increasing')
        this.sequence = event.seq
        this.events.push(event)
      }
      while (this.events.length > this.maxEvents) this.events.shift()
      await this.compactIfNeeded()
      if (!persistedGeneration && this.events[0]?.generation !== undefined) this.generation = this.events[0].generation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  append<TPayload extends Record<string, unknown>>(type: ControlEventType, payload: TPayload): ControlEvent<TPayload> {
    const event: ControlEvent<TPayload> = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      generation: this.generation,
      seq: ++this.sequence,
      eventId: randomUUID(),
      type,
      at: new Date().toISOString(),
      payload,
    }
    this.events.push(event)
    while (this.events.length > this.maxEvents) this.events.shift()
    if (this.filePath !== undefined) {
      const line = `${JSON.stringify(event)}\n`
      this.writeChain = this.writeChain.then(async () => {
        await mkdir(dirname(this.filePath as string), { recursive: true })
        await appendFile(this.filePath as string, line, { encoding: 'utf8', mode: 0o600 })
        await writeFile(`${this.filePath as string}.generation`, `${this.generation}\n`, { encoding: 'utf8', mode: 0o600 })
        await this.compactIfNeeded(event.seq)
      })
    }
    for (const subscriber of this.subscribers) subscriber(event)
    return event
  }

  list(after = 0, limit = 500): ControlEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('event cursor is invalid')
    return this.events.filter(event => event.seq > after).slice(0, Math.min(Math.max(limit, 1), 1000))
  }

  page(after = 0, limit = 500, generation?: string): EventPage {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('event cursor is invalid')
    const oldestSeq = this.events[0]?.seq ?? this.sequence + 1
    return {
      generation: this.generation,
      oldestSeq,
      latestSeq: this.sequence,
      resetRequired: generation !== undefined && generation !== this.generation || after > 0 && after < oldestSeq - 1,
      events: this.list(after, limit),
    }
  }

  oldestSequence(): number { return this.events[0]?.seq ?? this.sequence + 1 }
  latestSequence(): number { return this.sequence }
  subscribe(listener: (event: ControlEvent) => void): () => void { this.subscribers.add(listener); return () => this.subscribers.delete(listener) }
  async flush(): Promise<void> { await this.writeChain }

  private async compactIfNeeded(maxSequence = this.sequence): Promise<void> {
    if (this.filePath === undefined) return
    let size: number
    try { size = (await stat(this.filePath)).size } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (size <= this.maxFileBytes) return
    const snapshot = this.events.filter(event => event.seq <= maxSequence).slice(-this.maxEvents)
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.compact.tmp`
    await writeFile(temporary, snapshot.map(event => JSON.stringify(event)).join('\n') + (snapshot.length === 0 ? '' : '\n'), { encoding: 'utf8', mode: 0o600 })
    try { await rename(temporary, this.filePath) } catch (error) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await rm(this.filePath, { force: true }); await rename(temporary, this.filePath)
    }
  }
}

interface StoredDevice extends DeviceInfo {
  tokenHash: string
  refreshHash: string
  accessExpiresAt: string
  refreshExpiresAt: string
}
interface DeviceFile { schemaVersion: 1; serverId: string; publicKey: string; privateKey: string; devices: StoredDevice[] }

function hashToken(token: string): Buffer { return createHash('sha256').update(token).digest() }
function redactLegacyEvent(event: ControlEvent): ControlEvent {
  if (event.type !== 'task.updated' || typeof event.payload !== 'object' || event.payload === null) return event
  const payload = event.payload as Record<string, unknown>
  const next = { ...payload }
  if (Object.hasOwn(next, 'event')) next.event = { kind: 'legacy-session-event' }
  if (Array.isArray(next.jobs)) next.jobs = next.jobs.map(job => {
    if (typeof job !== 'object' || job === null) return { kind: 'legacy-job' }
    const value = job as Record<string, unknown>
    return { id: value.id, kind: value.kind, status: value.status, startedAt: value.startedAt, finishedAt: value.finishedAt }
  })
  return { ...event, payload: next }
}
function sameTokenHash(storedHash: string, token: string): boolean {
  const a = Buffer.from(storedHash, 'hex'); const b = hashToken(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

const ACCESS_TTL_MS = 15 * 60_000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000
function accessToken(): string { return `dshp_at_${randomBytes(32).toString('base64url')}` }
function refreshToken(): string { return `dshp_rt_${randomBytes(48).toString('base64url')}` }

export class DeviceRegistry {
  private state: DeviceFile
  private pending?: PairingOffer & { expiresMs: number; codeHash: string }
  constructor(private readonly filePath?: string) {
    const pair = generateKeyPairSync('ed25519')
    this.state = {
      schemaVersion: 1,
      serverId: randomUUID(),
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      devices: [],
    }
  }

  async load(): Promise<void> {
    if (this.filePath === undefined) return
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as DeviceFile
      if (!value.serverId || !value.publicKey || !value.privateKey || !Array.isArray(value.devices)) throw new Error('device registry is malformed')
      const privateKey = createPrivateKey({ key: Buffer.from(value.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
      const derivedPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
      if (derivedPublicKey !== value.publicKey) throw new Error('device registry server key binding is invalid')
      for (const device of value.devices) if (device.identityPublicKey !== undefined) createPublicKey({ key: Buffer.from(device.identityPublicKey, 'base64'), format: 'der', type: 'spki' })
      this.state = { ...value, schemaVersion: 1 }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private async save(): Promise<void> {
    if (this.filePath === undefined) return
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { await rename(temporary, this.filePath) } catch (error) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await rm(this.filePath, { force: true }); await rename(temporary, this.filePath)
    }
  }

  serverId(): string { return this.state.serverId }
  publicKey(): string { return this.state.publicKey }
  serverIdentity(): RelayIdentity {
    return { privateKey: createPrivateKey({ key: Buffer.from(this.state.privateKey, 'base64'), format: 'der', type: 'pkcs8' }), publicKey: this.state.publicKey }
  }
  list(): DeviceInfo[] { return this.state.devices.map(({ tokenHash: _tokenHash, refreshHash: _refreshHash, ...device }) => device) }

  createOffer(ttlMs = 120_000, workspaceIds: readonly string[] = [], options: { lanEndpoint?: string; relay?: { url: string; channelId: string; token: string; encryptionKey: string } } = {}): PairingOffer {
    const code = randomBytes(16).toString('hex').toUpperCase()
    const offer: PairingOffer = {
      schemaVersion: 1,
      offerId: randomUUID(),
      serverId: this.state.serverId, publicKey: this.state.publicKey, code, nonce: randomBytes(16).toString('base64url'),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ...(workspaceIds.length === 0 ? {} : { workspaceIds: [...new Set(workspaceIds)].slice(0, 64) }),
      ...(options.lanEndpoint === undefined ? {} : { lanEndpoint: options.lanEndpoint }),
      ...(options.relay === undefined ? {} : { relay: options.relay }),
    }
    this.pending = { ...offer, expiresMs: Date.now() + ttlMs, codeHash: createHash('sha256').update(code).digest('hex') }
    return offer
  }

  async pair(request: DevicePairingRequest | string, name?: string, scopes: readonly ControlScope[] = ['read', 'control'], options: { requireIdentity?: boolean } = {}): Promise<{ device: DeviceInfo; token: string; refreshToken: string }> {
    const input: DevicePairingRequest = typeof request === 'string' ? { code: request, name: name ?? '', scopes } : request
    const pending = this.pending
    const suppliedCodeHash = createHash('sha256').update(input.code).digest('hex')
    if (pending === undefined || Date.now() > pending.expiresMs || !sameHexHash(suppliedCodeHash, pending.codeHash)) throw new Error('pairing offer is invalid or expired')
    const hasIdentity = input.identityPublicKey !== undefined || input.pairingProof !== undefined || input.offerId !== undefined || input.serverId !== undefined || input.serverPublicKey !== undefined
    if (options.requireIdentity && !hasIdentity) throw new Error('device identity is required for remote pairing')
    if (hasIdentity) {
      if (input.identityPublicKey === undefined || input.pairingProof === undefined || input.offerId !== pending.offerId || input.serverId !== this.state.serverId || input.serverPublicKey !== this.state.publicKey) throw new Error('pairing server key binding is invalid')
      verifyPairingProof({ serverId: this.state.serverId, serverPublicKey: this.state.publicKey, offerId: pending.offerId, nonce: pending.nonce, identityPublicKey: input.identityPublicKey }, input.pairingProof)
    }
    this.pending = undefined
    const token = accessToken(); const nextRefreshToken = refreshToken()
    const now = Date.now()
    const allowedScopes: ControlScope[] = ['read', 'control', 'admin']
    const requestedScopes: readonly ControlScope[] = input.scopes ?? ['read', 'control']
    const offeredWorkspaceIds = pending.workspaceIds ?? []
    const requestedWorkspaceIds = input.workspaceIds === undefined ? offeredWorkspaceIds : [...new Set(input.workspaceIds)].filter(value => offeredWorkspaceIds.includes(value)).slice(0, 64)
    const device: StoredDevice = { deviceId: randomUUID(), name: input.name.trim().slice(0, 80) || 'Unnamed device', ...(input.identityPublicKey === undefined ? {} : { identityPublicKey: input.identityPublicKey }), ...(requestedWorkspaceIds.length === 0 ? {} : { workspaceIds: requestedWorkspaceIds }), scopes: [...new Set(requestedScopes)].filter((scope): scope is ControlScope => allowedScopes.includes(scope)), createdAt: new Date().toISOString(), accessExpiresAt: new Date(now + ACCESS_TTL_MS).toISOString(), refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(), tokenHash: hashToken(token).toString('hex'), refreshHash: hashToken(nextRefreshToken).toString('hex') }
    this.state.devices.push(device)
    await this.save()
    const { tokenHash: _tokenHash, refreshHash: _refreshHash, ...publicDevice } = device
    return { device: publicDevice, token, refreshToken: nextRefreshToken }
  }

  authorize(token: string | undefined, scope: ControlScope): DeviceInfo | undefined {
    if (token === undefined || token.length < 16) return undefined
    const device = this.state.devices.find(item => !item.revokedAt && Date.parse(item.accessExpiresAt) > Date.now() && sameTokenHash(item.tokenHash, token))
    if (device === undefined || !device.scopes.includes(scope) && !device.scopes.includes('admin')) return undefined
    device.lastSeenAt = new Date().toISOString()
    const { tokenHash: _tokenHash, refreshHash: _refreshHash, ...publicDevice } = device
    return publicDevice
  }

  async revoke(deviceId: string): Promise<DeviceInfo> {
    const device = this.state.devices.find(item => item.deviceId === deviceId)
    if (device === undefined) throw new Error('unknown device')
    device.revokedAt = new Date().toISOString(); await this.save()
    const { tokenHash: _tokenHash, refreshHash: _refreshHash, ...publicDevice } = device
    return publicDevice
  }

  async rotate(deviceId: string): Promise<{ device: DeviceInfo; token: string; refreshToken: string }> {
    const device = this.state.devices.find(item => item.deviceId === deviceId)
    if (device === undefined || device.revokedAt) throw new Error('unknown or revoked device')
    const token = accessToken(); const nextRefreshToken = refreshToken(); const now = Date.now()
    device.tokenHash = hashToken(token).toString('hex'); device.refreshHash = hashToken(nextRefreshToken).toString('hex'); device.accessExpiresAt = new Date(now + ACCESS_TTL_MS).toISOString(); device.refreshExpiresAt = new Date(now + REFRESH_TTL_MS).toISOString(); device.lastSeenAt = new Date().toISOString()
    await this.save()
    const { tokenHash: _tokenHash, refreshHash: _refreshHash, ...publicDevice } = device
    return { device: publicDevice, token, refreshToken: nextRefreshToken }
  }

  async refresh(deviceId: string, suppliedRefreshToken: string): Promise<{ device: DeviceInfo; token: string; refreshToken: string }> {
    const device = this.state.devices.find(item => item.deviceId === deviceId)
    if (device === undefined || device.revokedAt || Date.parse(device.refreshExpiresAt) <= Date.now() || !sameTokenHash(device.refreshHash, suppliedRefreshToken)) throw new Error('refresh token is invalid or expired')
    return this.rotate(deviceId)
  }
}

function sameHexHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ControlPlaneAdapter {
  runtimeStatus: () => RuntimeStatus
  sessions: () => Promise<SessionSummary[]>
  tasks: () => Promise<TaskSummary[]>
  admitPrompt?: (request: Extract<ControlRequest, { kind: 'prompt_admission' }>) => Promise<{ taskId: string }>
  interrupt?: (sessionId: string) => Promise<void>
  permissions?: (sessionId?: string) => Promise<PermissionSummary[]>
  questions?: () => Promise<unknown[]>
  permissionReply?: (permissionId: string, decision: 'allow' | 'deny') => Promise<void>
  questionReply?: (rpcId: string, sessionId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>) => Promise<void>
  artifacts?: () => Promise<unknown[]>
  artifactRead?: (artifactId: string) => Promise<Uint8Array>
  artifactOpen?: (artifactId: string) => Promise<{ opened: boolean }>
  artifactReveal?: (artifactId: string) => Promise<{ opened: boolean }>
  git?: (cwd: string, path?: string) => Promise<unknown>
  gitOpen?: (cwd: string, path: string) => Promise<{ opened: boolean }>
  gitReveal?: (cwd: string, path: string) => Promise<{ opened: boolean }>
  resources?: () => Promise<unknown[]>
  resourceResolve?: (resourceId: string, operation: string, input: Record<string, unknown>) => Promise<unknown>
  lineage?: (sessionId: string) => Promise<unknown[]>
}

export interface ResourceAuthorizationContext {
  device?: DeviceInfo
  scope: ControlScope
  operation: string
  sessionId?: string
  workspaceId?: string
  cwd?: string
  artifactId?: string
  resourceId?: string
  permissionId?: string
  questionId?: string
  request?: ControlRequest
}

export type AuthorizationDecision = boolean | { allowed: boolean; code?: string; message?: string }

export interface ControlPlaneServerOptions {
  version: string
  name?: string
  host?: string
  port?: number
  remoteEnabled?: boolean
  tls?: { key: string | Buffer; cert: string | Buffer }
  corsOrigins?: readonly string[]
  /** Additional Host header names accepted when the daemon is exposed remotely. */
  allowedHosts?: readonly string[]
  eventsPath?: string
  devicesPath?: string
  /** Keep admin scopes out of HTTP pairing unless the operator explicitly opts in. */
  allowLocalAdminPairing?: boolean
  /** Expose the one-time pairing offer endpoint to a direct local client. */
  allowLocalPairingOffer?: boolean
  /** Allow a bounded number of long-lived event streams per daemon. */
  maxSseConnections?: number
  /** Workspace ids advertised in local/relay pairing offers. */
  workspaceIds?: readonly string[]
  /** Enable the optional opaque WebSocket relay transport. */
  relayEnabled?: boolean
  /** LAN-scoped HTTP endpoint advertised in pairing offers for direct same-network control. */
  lanEndpoint?: string
  /** Relay connection details advertised in pairing offers for cross-network control. */
  relay?: { url: string; channelId: string; token: string; encryptionKey: string }
  /** Require a client identity proof when pairing from a non-loopback peer. */
  requireDeviceIdentityOnRemotePairing?: boolean
  /** Resource-level authorization seam; returning false is fail-closed. */
  authorization?: (context: ResourceAuthorizationContext) => AuthorizationDecision | Promise<AuthorizationDecision>
  adapter?: Partial<ControlPlaneAdapter>
}

export class ControlPlaneServer {
  readonly events: DurableEventStore
  readonly devices: DeviceRegistry
  private readonly server: Server
  private readonly relayServer?: WebSocketServer
  private readonly relayRouter = new RelayRouter()
  private readonly relaySockets = new Set<WebSocket>()
  private readonly options: Required<Pick<ControlPlaneServerOptions, 'version' | 'host' | 'port' | 'remoteEnabled'>> & ControlPlaneServerOptions
  private addressValue?: { host: string; port: number }
  private readonly admittedRequests = new Map<string, string>()
  private readonly inflightAdmissions = new Map<string, Promise<{ taskId: string }>>()
  private pairingAttempts = { windowStartedAt: Date.now(), count: 0 }
  private readonly requestWindows = new Map<string, { windowStartedAt: number; count: number }>()
  private activeSseConnections = 0
  private activeRelayConnections = 0

  constructor(options: ControlPlaneServerOptions) {
    this.options = { host: '127.0.0.1', port: 0, remoteEnabled: false, allowLocalAdminPairing: false, allowLocalPairingOffer: false, maxSseConnections: 8, requireDeviceIdentityOnRemotePairing: true, ...options }
    if (!this.options.remoteEnabled && !isLoopbackHost(this.options.host)) throw new Error('remote mode must be explicitly enabled before binding a non-loopback host')
    if (this.options.remoteEnabled && !isLoopbackHost(this.options.host) && this.options.tls === undefined) throw new Error('remote mode requires TLS key/cert when binding a non-loopback host')
    this.events = new DurableEventStore({ filePath: this.options.eventsPath })
    this.devices = new DeviceRegistry(this.options.devicesPath)
    const handler = (request: IncomingMessage, response: ServerResponse): void => { void this.handle(request, response) }
    this.server = this.options.tls === undefined ? createServer(handler) : createSecureServer(this.options.tls, handler)
    if (this.options.relayEnabled) {
      this.relayServer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
      this.server.on('upgrade', (request, socket, head) => { void this.handleRelayUpgrade(request, socket, head) })
    }
  }

  async start(): Promise<{ host: string; port: number }> {
    // A remote-enabled control plane is a durable authority over paired
    // devices, refresh tokens, and revocation. Running it purely in memory
    // would lose the device registry on restart, defeating revocation and
    // token rotation. Refuse to start unless a persistent device file is set.
    if (this.options.remoteEnabled && this.options.devicesPath === undefined) throw new Error('remote control plane requires a persistent device registry (devicesPath)')
    await this.events.load(); await this.devices.load()
    // On restart, any job still reported as running/stopping when the daemon
    // last stopped is now stale: the process that owned it is gone. Mark it
    // interrupted and emit durable events so the remote UI never shows a
    // permanently "running" task and the audit log reflects reality.
    this.hydrateStaleJobs()
    for (const event of this.events.list()) {
      if (event.type === 'prompt.accepted' && typeof event.payload.requestId === 'string' && typeof event.payload.taskId === 'string') this.admittedRequests.set(event.payload.requestId, event.payload.taskId)
    }
    await new Promise<void>((resolveStart, reject) => { this.server.once('error', reject); this.server.listen(this.options.port, this.options.host, () => resolveStart()) })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('control plane address unavailable')
    this.addressValue = { host: address.address, port: address.port }
    this.events.append('server.connected', { host: address.address, port: address.port })
    return this.addressValue
  }

  async stop(): Promise<void> { this.events.append('server.disconnected', {}); await this.events.flush(); for (const socket of this.relaySockets) socket.terminate(); this.relaySockets.clear(); this.relayServer?.close(); await new Promise<void>(resolveStop => this.server.close(() => resolveStop())) }
  private hydrateStaleJobs(): void {
    const latestByJob = new Map<string, { sessionId: string; id: string; kind: string; status: string; startedAt?: number; finishedAt?: number }>()
    for (const event of this.events.list()) {
      if (event.type !== 'task.updated') continue
      const payload = event.payload as { sessionId?: string; jobs?: Array<{ id: string; kind: string; status: string; startedAt?: number; finishedAt?: number }> }
      if (!Array.isArray(payload.jobs)) continue
      for (const job of payload.jobs) latestByJob.set(job.id, { sessionId: payload.sessionId ?? '', id: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt })
    }
    const bySession = new Map<string, Array<{ id: string; kind: string; status: string; startedAt?: number; finishedAt?: number }>>()
    for (const job of latestByJob.values()) {
      if (job.status !== 'running' && job.status !== 'stopping') continue
      const list = bySession.get(job.sessionId) ?? []
      list.push({ id: job.id, kind: job.kind, status: 'interrupted', startedAt: job.startedAt, finishedAt: Date.now() })
      bySession.set(job.sessionId, list)
    }
    for (const [sessionId, jobs] of bySession) {
      this.events.append('task.updated', { sessionId, jobs, restarted: true })
      for (const job of jobs) this.events.append('job.interrupted', { sessionId, jobId: job.id, kind: job.kind })
    }
  }
  address(): { host: string; port: number } | undefined { return this.addressValue }

  /**
   * Build a pairing offer that already embeds the server's LAN and relay
   * endpoints, so a scanning client can auto-route (direct LAN, then relay).
   */
  offerPairing(ttlMs = 120_000, workspaceIds: readonly string[] = []): PairingOffer {
    return this.devices.createOffer(ttlMs, workspaceIds, { lanEndpoint: this.options.lanEndpoint, relay: this.options.relay })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      this.headers(response, request)
      this.validateRequestSecurity(request, url)
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
      this.enforceRateLimit(request)
      if (url.pathname === '/health' && request.method === 'GET') { this.json(response, 200, { ok: true, protocolVersion: CONTROL_PROTOCOL_VERSION }); return }
      if (url.pathname === '/v1/server' && request.method === 'GET') { this.authorize(request, 'read'); this.json(response, 200, { ok: true, value: this.serverInfo() }); return }
      if (url.pathname === '/v1/runtime' && request.method === 'GET') { this.authorize(request, 'read'); this.json(response, 200, { ok: true, value: this.options.adapter?.runtimeStatus?.() ?? { state: 'idle', restartCount: 0 } }); return }
      if (url.pathname === '/v1/sessions' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'session_list' }); this.json(response, 200, { ok: true, value: this.scopeList(await (this.options.adapter?.sessions?.() ?? Promise.resolve([])), device) }); return }
      if (url.pathname === '/v1/tasks' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'task_list' }); this.json(response, 200, { ok: true, value: this.scopeList(await (this.options.adapter?.tasks?.() ?? Promise.resolve([])), device) }); return }
      if (url.pathname === '/v1/permissions' && request.method === 'GET') { const sessionId = url.searchParams.get('sessionId') ?? undefined; const device = await this.authorizeResource(request, 'read', { operation: 'permission_list', ...(sessionId === undefined ? {} : { sessionId }) }); this.json(response, 200, { ok: true, value: this.scopeList(await (this.options.adapter?.permissions?.(sessionId) ?? Promise.resolve([])), device) }); return }
      if (url.pathname === '/v1/questions' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'question_list', workspaceId: url.searchParams.get('workspaceId') ?? undefined }); this.json(response, 200, { ok: true, value: this.scopeList(await (this.options.adapter?.questions?.() ?? Promise.resolve([])), device) }); return }
      if (url.pathname === '/v1/artifacts' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'artifact_list', workspaceId: url.searchParams.get('workspaceId') ?? undefined }); this.json(response, 200, { ok: true, value: this.scopeList(await (this.options.adapter?.artifacts?.() ?? Promise.resolve([])), device) }); return }
      if (url.pathname === '/v1/git' && request.method === 'GET') { const cwd = url.searchParams.get('cwd') ?? ''; await this.authorizeResource(request, 'read', { operation: 'git_summary', cwd }); if (this.options.adapter?.git === undefined) throw new Error('git adapter is not configured'); this.json(response, 200, { ok: true, value: await this.options.adapter.git(cwd, url.searchParams.get('path') ?? undefined) }); return }
      if (url.pathname === '/v1/resources' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'resource_list', workspaceId: url.searchParams.get('workspaceId') ?? undefined }); this.json(response, 200, { ok: true, value: this.scopeList(await (this.options.adapter?.resources?.() ?? Promise.resolve([])), device) }); return }
      if (url.pathname.startsWith('/v1/resources/') && request.method === 'GET') { const resourceId = decodeURIComponent(url.pathname.slice('/v1/resources/'.length)); const device = await this.authorizeResource(request, 'read', { operation: 'resource_resolve', resourceId, workspaceId: url.searchParams.get('workspaceId') ?? undefined }); await this.requireWorkspaceScopeForItem(device, this.options.adapter?.resources?.() ?? Promise.resolve([]), resourceId, 'resourceId'); if (this.options.adapter?.resourceResolve === undefined) throw new Error('resource provider adapter is not configured'); const operation = url.searchParams.get('operation') ?? 'inspect'; const input = Object.fromEntries(url.searchParams.entries()); delete input.operation; delete input.workspaceId; this.json(response, 200, { ok: true, value: await this.options.adapter.resourceResolve(resourceId, operation, input) }); return }
      if (url.pathname.startsWith('/v1/sessions/') && url.pathname.endsWith('/lineage') && request.method === 'GET') { const sessionId = decodeURIComponent(url.pathname.slice('/v1/sessions/'.length, -'/lineage'.length)); await this.authorizeResource(request, 'read', { operation: 'session_lineage', sessionId }); this.json(response, 200, { ok: true, value: await (this.options.adapter?.lineage?.(sessionId) ?? Promise.resolve([])) }); return }
      if (url.pathname.startsWith('/v1/artifacts/') && url.pathname.endsWith('/open') && request.method === 'POST') { const artifactId = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length, -'/open'.length)); const device = await this.authorizeResource(request, 'control', { operation: 'artifact_open', artifactId, workspaceId: url.searchParams.get('workspaceId') ?? undefined }); await this.requireWorkspaceScopeForItem(device, this.options.adapter?.artifacts?.() ?? Promise.resolve([]), artifactId, 'artifactId'); if (this.options.adapter?.artifactOpen === undefined) throw new Error('artifact open adapter is not configured'); this.json(response, 200, { ok: true, value: await this.options.adapter.artifactOpen(artifactId) }); return }
      if (url.pathname.startsWith('/v1/artifacts/') && url.pathname.endsWith('/reveal') && request.method === 'POST') { const artifactId = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length, -'/reveal'.length)); const device = await this.authorizeResource(request, 'control', { operation: 'artifact_reveal', artifactId, workspaceId: url.searchParams.get('workspaceId') ?? undefined }); await this.requireWorkspaceScopeForItem(device, this.options.adapter?.artifacts?.() ?? Promise.resolve([]), artifactId, 'artifactId'); if (this.options.adapter?.artifactReveal === undefined) throw new Error('artifact reveal adapter is not configured'); this.json(response, 200, { ok: true, value: await this.options.adapter.artifactReveal(artifactId) }); return }
      if (url.pathname.startsWith('/v1/artifacts/') && request.method === 'GET') { const artifactId = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length)); const device = await this.authorizeResource(request, 'read', { operation: 'artifact_read', artifactId, workspaceId: url.searchParams.get('workspaceId') ?? undefined }); await this.requireWorkspaceScopeForItem(device, this.options.adapter?.artifacts?.() ?? Promise.resolve([]), artifactId, 'artifactId'); if (this.options.adapter?.artifactRead === undefined) throw new Error('artifact adapter is not configured'); const data = await this.options.adapter.artifactRead(artifactId); response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': data.byteLength }); response.end(Buffer.from(data)); return }
      if (url.pathname === '/v1/git/open' && request.method === 'POST') { const value = await readJson(request); const cwd = String(value.cwd ?? ''); const path = String(value.path ?? ''); await this.authorizeResource(request, 'control', { operation: 'git_open', cwd }); if (this.options.adapter?.gitOpen === undefined) throw new Error('git open adapter is not configured'); this.json(response, 200, { ok: true, value: await this.options.adapter.gitOpen(cwd, path) }); return }
      if (url.pathname === '/v1/git/reveal' && request.method === 'POST') { const value = await readJson(request); const cwd = String(value.cwd ?? ''); const path = String(value.path ?? ''); await this.authorizeResource(request, 'control', { operation: 'git_reveal', cwd }); if (this.options.adapter?.gitReveal === undefined) throw new Error('git reveal adapter is not configured'); this.json(response, 200, { ok: true, value: await this.options.adapter.gitReveal(cwd, path) }); return }
      if (url.pathname === '/v1/events' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'event_list', workspaceId: url.searchParams.get('workspaceId') ?? undefined }); const sessionWorkspace = await this.resolveSessionWorkspaceMap(); const page = this.events.page(Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 500), url.searchParams.get('generation') ?? undefined); page.events = this.filterEventsByWorkspace(page.events, sessionWorkspace, device?.workspaceIds); this.json(response, 200, { ok: true, value: page }); return }
      if (url.pathname === '/v1/events/stream' && request.method === 'GET') { const device = await this.authorizeResource(request, 'read', { operation: 'event_list', workspaceId: url.searchParams.get('workspaceId') ?? undefined }); const sessionWorkspace = await this.resolveSessionWorkspaceMap(); await this.sse(request, response, Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0), url.searchParams.get('generation') ?? undefined, device?.workspaceIds, sessionWorkspace); return }
      if (url.pathname === '/v1/pairing/offer' && request.method === 'POST') { this.authorizeLocalOrAdmin(request); this.json(response, 200, { ok: true, value: this.offerPairing(120_000, this.options.workspaceIds ?? []) }); return }
      if (url.pathname === '/v1/pair' && request.method === 'POST') { const local = this.authorizePairRequest(request); const body = await readJson(request); const requestedScopes = Array.isArray(body.scopes) ? body.scopes as ControlScope[] : undefined; const scopes = local && this.options.allowLocalAdminPairing ? requestedScopes : requestedScopes?.filter(scope => scope !== 'admin'); const workspaceIds = Array.isArray(body.workspaceIds) && body.workspaceIds.every(value => typeof value === 'string') ? body.workspaceIds as string[] : undefined; const pairing: DevicePairingRequest = { code: String(body.code ?? ''), name: String(body.name ?? ''), ...(scopes === undefined ? {} : { scopes }), ...(workspaceIds === undefined ? {} : { workspaceIds }), ...(typeof body.offerId === 'string' ? { offerId: body.offerId } : {}), ...(typeof body.serverId === 'string' ? { serverId: body.serverId } : {}), ...(typeof body.serverPublicKey === 'string' ? { serverPublicKey: body.serverPublicKey } : {}), ...(typeof body.identityPublicKey === 'string' ? { identityPublicKey: body.identityPublicKey } : {}), ...(typeof body.pairingProof === 'string' ? { pairingProof: body.pairingProof } : {}) }; const result = await this.devices.pair(pairing, undefined, ['read', 'control'], { requireIdentity: !local && this.options.requireDeviceIdentityOnRemotePairing === true }); this.events.append('device.paired', { deviceId: result.device.deviceId, name: result.device.name }); this.json(response, 200, { ok: true, value: result }); return }
      if (url.pathname === '/v1/token/refresh' && request.method === 'POST') { const body = await readJson(request); const result = await this.devices.refresh(String(body.deviceId ?? ''), String(body.refreshToken ?? '')); this.json(response, 200, { ok: true, value: result }); return }
      if (url.pathname === '/v1/devices' && request.method === 'GET') { this.authorize(request, 'admin'); this.json(response, 200, { ok: true, value: this.devices.list() }); return }
      if (url.pathname.startsWith('/v1/devices/') && request.method === 'DELETE') { this.authorize(request, 'admin'); const device = await this.devices.revoke(decodeURIComponent(url.pathname.slice('/v1/devices/'.length))); this.events.append('device.revoked', { deviceId: device.deviceId }); this.json(response, 200, { ok: true, value: device }); return }
      if (url.pathname.startsWith('/v1/devices/') && url.pathname.endsWith('/rotate') && request.method === 'POST') { this.authorize(request, 'admin'); const deviceId = decodeURIComponent(url.pathname.slice('/v1/devices/'.length, -'/rotate'.length)); const result = await this.devices.rotate(deviceId); this.events.append('device.paired', { deviceId: result.device.deviceId, name: result.device.name, rotated: true }); this.json(response, 200, { ok: true, value: result }); return }
      if (url.pathname === '/v1/control' && request.method === 'POST') { const requestValue = await readJson(request); assertControlRequest(requestValue); const result = await this.control(request, requestValue); this.json(response, result.ok ? 200 : 400, result); return }
      this.json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'route not found' } })
    } catch (error) {
      const rateLimited = error instanceof RateLimitError
      const unauthorized = error instanceof AuthError
      if (rateLimited) response.setHeader('Retry-After', String((error as RateLimitError).retryAfterSeconds))
      this.json(response, rateLimited ? 429 : unauthorized ? 401 : 400, { ok: false, error: { code: rateLimited ? 'RATE_LIMITED' : unauthorized ? 'UNAUTHORIZED' : 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) } })
    }
  }

  private async control(request: IncomingMessage, value: ControlRequest): Promise<ControlResponse> {
    const scope: ControlScope = value.kind === 'device_list' || value.kind === 'device_revoke' || value.kind === 'device_rotate' ? 'admin' : value.kind === 'prompt_admission' || value.kind === 'interrupt' || value.kind === 'permission_reply' || value.kind === 'question_reply' ? 'control' : 'read'
    const authorizedDevice = await this.authorizeResource(request, scope, { request: value, operation: value.kind, ...(value.kind === 'prompt_admission' ? { sessionId: value.sessionId, workspaceId: value.workspaceId, cwd: value.cwd } : value.kind === 'interrupt' ? { sessionId: value.sessionId, workspaceId: value.workspaceId } : value.kind === 'permission_list' ? { sessionId: value.sessionId, workspaceId: value.workspaceId } : value.kind === 'question_reply' ? { sessionId: value.sessionId, workspaceId: value.workspaceId } : {}) })
    if (value.kind === 'events') { const sessionWorkspace = await this.resolveSessionWorkspaceMap(); const scoped = this.filterEventsByWorkspace(this.events.list(value.after, value.limit), sessionWorkspace, authorizedDevice?.workspaceIds); return { ok: true, value: scoped } }
    if (value.kind === 'server_info') return { ok: true, value: this.serverInfo() }
    if (value.kind === 'runtime_status') return { ok: true, value: this.options.adapter?.runtimeStatus?.() ?? { state: 'idle', restartCount: 0 } }
    if (value.kind === 'session_list') return { ok: true, value: this.scopeList(await (this.options.adapter?.sessions?.() ?? Promise.resolve([])), authorizedDevice) }
    if (value.kind === 'task_list') return { ok: true, value: this.scopeList(await (this.options.adapter?.tasks?.() ?? Promise.resolve([])), authorizedDevice) }
    if (value.kind === 'permission_list') return { ok: true, value: this.scopeList(await (this.options.adapter?.permissions?.(value.sessionId) ?? Promise.resolve([])), authorizedDevice) }
    if (value.kind === 'prompt_admission') {
      const admitted = this.admittedRequests.get(value.requestId)
      if (admitted !== undefined) return { ok: true, requestId: value.requestId, value: { taskId: admitted, deduplicated: true } }
      const inflight = this.inflightAdmissions.get(value.requestId)
      if (inflight !== undefined) {
        const result = await inflight
        return { ok: true, requestId: value.requestId, value: { ...result, deduplicated: true } }
      }
      if (this.options.adapter?.admitPrompt === undefined) return { ok: false, requestId: value.requestId, error: { code: 'NOT_CONFIGURED', message: 'prompt admission adapter is not configured' } }
      const admission = this.options.adapter.admitPrompt(value).then(result => {
        this.admittedRequests.set(value.requestId, result.taskId)
        this.events.append('prompt.accepted', { requestId: value.requestId, taskId: result.taskId })
        return result
      })
      this.inflightAdmissions.set(value.requestId, admission)
      try {
        return { ok: true, requestId: value.requestId, value: await admission }
      } finally {
        if (this.inflightAdmissions.get(value.requestId) === admission) this.inflightAdmissions.delete(value.requestId)
      }
    }
    if (value.kind === 'interrupt') {
      if (this.options.adapter?.interrupt === undefined) return { ok: false, requestId: value.requestId, error: { code: 'NOT_CONFIGURED', message: 'interrupt adapter is not configured' } }
      await this.options.adapter.interrupt(value.sessionId); return { ok: true, requestId: value.requestId, value: { interrupted: true } }
    }
    if (value.kind === 'permission_reply') {
      if (this.options.adapter?.permissionReply === undefined) return { ok: false, requestId: value.requestId, error: { code: 'NOT_CONFIGURED', message: 'permission adapter is not configured' } }
      await this.options.adapter.permissionReply(value.permissionId, value.decision); this.events.append('permission.resolved', { permissionId: value.permissionId, decision: value.decision }); return { ok: true, requestId: value.requestId, value: { resolved: true } }
    }
    if (value.kind === 'question_reply') {
      if (this.options.adapter?.questionReply === undefined) return { ok: false, requestId: value.requestId, error: { code: 'NOT_CONFIGURED', message: 'question adapter is not configured' } }
      await this.options.adapter.questionReply(value.rpcId, value.sessionId, value.answers); this.events.append('task.updated', { sessionId: value.sessionId, waitingFor: 'user-question-resolved' }); return { ok: true, requestId: value.requestId, value: { resolved: true } }
    }
    if (value.kind === 'device_list') return { ok: true, value: this.devices.list() }
    if (value.kind === 'device_revoke') { const device = await this.devices.revoke(value.deviceId); this.events.append('device.revoked', { deviceId: device.deviceId }); return { ok: true, value: device } }
    if (value.kind === 'device_rotate') { const result = await this.devices.rotate(value.deviceId); this.events.append('device.paired', { deviceId: result.device.deviceId, name: result.device.name, rotated: true }); return { ok: true, value: result } }
    return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'control request is not connected to the official Harness API' } }
  }

  private serverInfo(): ServerInfo {
    const capabilities = ['events', 'sessions', 'tasks', 'runtime', 'pairing', 'restricted-control', 'permissions', 'questions', 'steer', 'refresh-token']
    if (this.options.adapter?.artifacts !== undefined) capabilities.push('artifacts')
    if (this.options.adapter?.artifactOpen !== undefined) capabilities.push('artifact-open')
    if (this.options.adapter?.artifactReveal !== undefined) capabilities.push('artifact-reveal')
    if (this.options.adapter?.git !== undefined) capabilities.push('git')
    if (this.options.adapter?.gitOpen !== undefined) capabilities.push('git-open')
    if (this.options.adapter?.gitReveal !== undefined) capabilities.push('git-reveal')
    if (this.options.adapter?.resources !== undefined) capabilities.push('resources')
    if (this.options.adapter?.resourceResolve !== undefined) capabilities.push('resource-providers')
    if (this.options.adapter?.lineage !== undefined) capabilities.push('lineage')
    if (this.options.relayEnabled) capabilities.push('relay-e2ee')
    return { protocolVersion: CONTROL_PROTOCOL_VERSION, serverId: this.devices.serverId(), name: this.options.name ?? 'DSHPilot', version: this.options.version, capabilities, remoteEnabled: this.options.remoteEnabled, loopbackOnly: isLoopbackHost(this.options.host), publicKey: this.devices.publicKey() }
  }
  private enforceRateLimit(request: IncomingMessage): void {
    const key = request.socket.remoteAddress ?? 'unknown'
    const now = Date.now(); const current = this.requestWindows.get(key)
    const window = current !== undefined && now - current.windowStartedAt <= 60_000 ? current : { windowStartedAt: now, count: 0 }
    window.count += 1; this.requestWindows.set(key, window)
    if (window.count > 600) throw new RateLimitError()
    if (this.requestWindows.size > 1_000) for (const [address, state] of this.requestWindows) if (now - state.windowStartedAt > 60_000) this.requestWindows.delete(address)
  }
  private headers(response: ServerResponse, request: IncomingMessage): void { const origin = request.headers.origin; if (origin !== undefined && (this.options.corsOrigins?.includes(origin) ?? false)) response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,last-event-id'); response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS'); response.setHeader('Vary', 'Origin'); response.setHeader('X-Content-Type-Options', 'nosniff') }
  private validateRequestSecurity(request: IncomingMessage, url: URL): void {
    const hostHeader = request.headers.host
    if (hostHeader === undefined || hostHeader.length > 255) throw new Error('Host header is required')
    const host = new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    const configuredHosts = new Set([this.options.host.toLowerCase(), ...(this.options.allowedHosts ?? []).map(value => value.toLowerCase()), '127.0.0.1', 'localhost', '::1'])
    if (!configuredHosts.has(host) && !(isLoopbackHost(this.options.host) && isLoopbackHost(host))) throw new Error('Host header is not allowed')
    const origin = request.headers.origin
    if (origin === undefined) return
    let parsedOrigin: URL
    try { parsedOrigin = new URL(origin) } catch { throw new Error('Origin header is invalid') }
    const expectedOrigin = `${this.options.tls === undefined ? 'http' : 'https'}://${hostHeader}`
    const sameOrigin = parsedOrigin.origin === new URL(expectedOrigin).origin
    if (!(this.options.corsOrigins?.includes(origin) ?? false) && !sameOrigin) throw new Error('Origin is not allowed')
    if (!this.options.remoteEnabled && !isLoopbackHost(host)) throw new Error('non-loopback Origin is not allowed in local mode')
    void url
  }
  private json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
  private authorizeLocalOrAdmin(request: IncomingMessage): void { if (this.options.allowLocalPairingOffer && isLoopbackHost(request.socket.remoteAddress ?? '')) return; if (this.authorize(request, 'admin') !== undefined) return; throw new AuthError() }
  private authorizePairRequest(request: IncomingMessage): boolean {
    if (isLoopbackHost(request.socket.remoteAddress ?? '')) return true
    if (!this.options.remoteEnabled) throw new AuthError()
    const now = Date.now()
    if (now - this.pairingAttempts.windowStartedAt > 60_000) this.pairingAttempts = { windowStartedAt: now, count: 0 }
    if (++this.pairingAttempts.count > 10) throw new AuthError()
    return false
  }
  private authorize(request: IncomingMessage, scope: ControlScope): DeviceInfo | undefined { if (this.options.remoteEnabled === false && isLoopbackHost(request.socket.remoteAddress ?? '')) return undefined; const token = request.headers.authorization?.replace(/^Bearer\s+/iu, ''); const device = this.devices.authorize(token, scope); if (device === undefined) throw new AuthError(); return device }
  private async authorizeResource(request: IncomingMessage, scope: ControlScope, context: Omit<ResourceAuthorizationContext, 'device' | 'scope'>): Promise<DeviceInfo | undefined> {
    const device = this.authorize(request, scope)
    if (context.workspaceId !== undefined && device?.workspaceIds !== undefined && device.workspaceIds.length > 0 && !device.workspaceIds.includes(context.workspaceId)) throw new AuthError('device is not paired for this workspace')
    if (this.options.authorization === undefined) return device
    const decision = await this.options.authorization({ ...context, device, scope })
    if (decision === false || typeof decision === 'object' && decision.allowed !== true) {
      const message = typeof decision === 'object' && decision.message !== undefined ? decision.message : 'remote resource is not authorized for this device'
      throw new AuthError(message)
    }
    return device
  }
  private scopeList<T>(value: T[], device: DeviceInfo | undefined): T[] {
    const workspaceIds = device?.workspaceIds
    if (workspaceIds === undefined || workspaceIds.length === 0) return value
    return value.filter(item => typeof item === 'object' && item !== null && 'workspaceId' in item && typeof (item as { workspaceId?: unknown }).workspaceId === 'string' && workspaceIds.includes((item as { workspaceId: string }).workspaceId))
  }
  /** Resolve sessionId -> workspaceId so events (which are not workspace-tagged) can be scoped for workspace-restricted devices. */
  private async resolveSessionWorkspaceMap(): Promise<Map<string, string>> {
    const sessions = (await (this.options.adapter?.sessions?.() ?? Promise.resolve([]))) as Array<{ sessionId?: string; workspaceId?: string }>
    const map = new Map<string, string>()
    for (const session of sessions) if (typeof session.sessionId === 'string' && typeof session.workspaceId === 'string') map.set(session.sessionId, session.workspaceId)
    return map
  }
  /** A workspace-restricted device may see infra events (no session tag) and events for sessions inside its workspaces. */
  private eventInWorkspace(event: ControlEvent, sessionWorkspace: Map<string, string>, workspaceIds: readonly string[]): boolean {
    const sessionId = (event.payload as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string') return true
    const workspace = sessionWorkspace.get(sessionId)
    if (workspace === undefined) return true
    return workspaceIds.includes(workspace)
  }
  private filterEventsByWorkspace(events: ControlEvent[], sessionWorkspace: Map<string, string>, workspaceIds: readonly string[] | undefined): ControlEvent[] {
    if (workspaceIds === undefined || workspaceIds.length === 0) return events
    return events.filter(event => this.eventInWorkspace(event, sessionWorkspace, workspaceIds))
  }
  /** Fail-closed workspace scoping for get-by-id routes: a workspace-restricted device may only read items whose workspace it is paired for. */
  private async requireWorkspaceScopeForItem(device: DeviceInfo | undefined, items: Promise<unknown[]>, id: string, idKey: string): Promise<void> {
    const workspaceIds = device?.workspaceIds
    if (workspaceIds === undefined || workspaceIds.length === 0) return
    const resolved = (await items) as Array<Record<string, unknown>>
    const match = resolved.find(item => item[idKey] === id)
    if (match === undefined) throw new AuthError('resource is not available for this device')
    const workspaceId = match.workspaceId
    if (typeof workspaceId === 'string' && !workspaceIds.includes(workspaceId)) throw new AuthError('device is not paired for this workspace')
  }
  private async sse(request: IncomingMessage, response: ServerResponse, after: number, generation: string | undefined, workspaceIds: readonly string[] | undefined, sessionWorkspace: Map<string, string>): Promise<void> {
    if (this.activeSseConnections >= (this.options.maxSseConnections ?? 8)) throw new RateLimitError('too many event streams')
    this.activeSseConnections += 1
    let unsubscribe: (() => void) | undefined
    try {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' })
      let streaming = false
      const buffered: ControlEvent[] = []
      const allowed = (event: ControlEvent): boolean => workspaceIds === undefined || workspaceIds.length === 0 || this.eventInWorkspace(event, sessionWorkspace, workspaceIds)
      unsubscribe = this.events.subscribe(event => {
        if (!streaming) { buffered.push(event); return }
        if (allowed(event) && !response.destroyed) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
      })
      const page = this.events.page(after, 500, generation)
      const filtered = this.filterEventsByWorkspace(page.events, sessionWorkspace, workspaceIds)
      if (page.resetRequired) response.write(`event: reset-required\ndata: ${JSON.stringify({ generation: page.generation, oldestSeq: page.oldestSeq })}\n\n`)
      for (const event of filtered) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
      streaming = true
      for (const event of buffered) if (event.seq > page.latestSeq && allowed(event) && !response.destroyed) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
      const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n') }, 15_000)
      await new Promise<void>(resolveClose => request.on('close', () => { clearInterval(heartbeat); unsubscribe?.(); unsubscribe = undefined; resolveClose() }))
    } finally { unsubscribe?.(); this.activeSseConnections -= 1 }
  }

  private async handleRelayUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      this.validateRequestSecurity(request, url)
      if (url.pathname !== '/v1/relay' || this.relayServer === undefined) { socket.destroy(); return }
      if (this.activeRelayConnections >= 8) { socket.destroy(); return }
      const device = this.authorize(request, 'control')
      if (device?.identityPublicKey === undefined) { socket.destroy(); return }
      this.relayServer.handleUpgrade(request, socket, head, ws => this.handleRelayConnection(ws, device))
    } catch { socket.destroy() }
  }

  private handleRelayConnection(ws: WebSocket, device?: DeviceInfo): void {
    this.relaySockets.add(ws)
    this.activeRelayConnections += 1
    const connectionId = randomUUID()
    let sessionId: string | undefined
    let unregister: (() => void) | undefined
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { if (sessionId === undefined) ws.close(1008, 'relay handshake timeout') }, 10_000)
    let rateWindow = Date.now()
    let rateCount = 0
    let closed = false
    const close = (): void => { if (closed) return; closed = true; this.relaySockets.delete(ws); this.activeRelayConnections = Math.max(0, this.activeRelayConnections - 1); if (handshakeTimer !== undefined) clearTimeout(handshakeTimer); handshakeTimer = undefined; unregister?.(); unregister = undefined; sessionId = undefined }
    ws.on('message', (data: RawData) => {
      try {
        if (Date.now() - rateWindow >= 1_000) { rateWindow = Date.now(); rateCount = 0 }
        rateCount += 1
        if (rateCount > 120) throw new Error('relay rate limit exceeded')
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('relay frame exceeds 4 MiB')
        const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
        if (sessionId === undefined) {
          if (value.type !== 'handshake' || typeof value.handshake !== 'object' || value.handshake === null) throw new Error('relay handshake is required')
          const handshake = value.handshake as RelayHandshake
          verifyRelayHandshake(handshake, {
            expectedServerId: this.devices.serverId(),
            expectedServerPublicKey: this.devices.publicKey(),
            ...(device?.identityPublicKey === undefined ? {} : { expectedDeviceId: device.deviceId, expectedIdentityPublicKey: device.identityPublicKey }),
          })
          sessionId = handshake.sessionId
          if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
          handshakeTimer = undefined
          unregister = this.relayRouter.registerAuthenticated(sessionId, connectionId, handshake, frame => { if (ws.readyState === ws.OPEN) ws.send(frame) }, {
            expectedServerId: this.devices.serverId(),
            expectedServerPublicKey: this.devices.publicKey(),
            ...(device?.identityPublicKey === undefined ? {} : { expectedDeviceId: device.deviceId, expectedIdentityPublicKey: device.identityPublicKey }),
          })
          ws.send(JSON.stringify(signRelayReady(this.devices.serverIdentity(), handshake)))
          return
        }
        if (value.sessionId !== sessionId || value.version !== 1 || (value.direction !== 'client_to_server' && value.direction !== 'server_to_client') || !Number.isSafeInteger(value.frameSeq)
          || typeof value.nonce !== 'string' || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.ciphertext !== 'string'
          || (value.aad !== undefined && typeof value.aad !== 'string')) throw new Error('relay encrypted frame envelope is invalid')
        this.relayRouter.forwardAuthenticated(sessionId, connectionId, value as unknown as EncryptedRelayFrame, bytes)
      } catch { ws.close(1008, 'invalid relay frame') }
    })
    ws.on('close', close)
    ws.on('error', close)
  }
}

class AuthError extends Error {}
class RateLimitError extends Error { readonly retryAfterSeconds = 60; constructor(message = 'rate limit exceeded') { super(message) } }
function isLoopbackHost(value: string): boolean { return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const data = Buffer.from(chunk as Uint8Array); bytes += data.length; if (bytes > 256 * 1024) throw new Error('request body is too large'); chunks.push(data) } const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object'); return value as Record<string, unknown> }
