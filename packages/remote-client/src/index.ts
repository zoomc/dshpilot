import type { ControlEvent, ControlResponse, DeviceInfo, EventPage, PairingOffer, PermissionSummary, ServerInfo, TaskSummary, SessionSummary } from '@dshpilot/control-contracts'

export interface RemoteCredentials { device: DeviceInfo; token: string; refreshToken: string }
export interface RemoteClientOptions { baseUrl: string; token?: string; refreshToken?: string; deviceId?: string; fetchImpl?: typeof fetch; onCredentialsChanged?: (credentials: RemoteCredentials) => void }
export interface EventStreamOptions { after?: number; generation?: string; signal?: AbortSignal; onEvent: (event: ControlEvent) => void }

export interface RelayChannelOptions { relayUrl: string; channelId: string; role: 'desktop' | 'client'; token?: string }
export type RelayFrameListener = (frame: Uint8Array) => void

/**
 * Native WebSocket peer for the blind self-hosted relay. It only transports
 * already-encrypted relay frames; the HTTP control client remains separate so
 * the relay cannot become a general RPC proxy.
 */
export class RemoteRelayChannel {
  socket!: WebSocket
  private readonly listeners = new Set<RelayFrameListener>()
  private readyPromise!: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readyState = false
  private closed = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectBackoff = 500
  private readonly options: RelayChannelOptions
  constructor(options: RelayChannelOptions) {
    this.options = options; this.connect()
  }
  private connect(): void {
    if (this.closed) return
    const base = new URL(this.options.relayUrl); base.pathname = `${base.pathname.replace(/\/$/u, '')}/v1/relay/${encodeURIComponent(this.options.channelId)}`
    const protocols = this.options.token === undefined ? undefined : [`dshpilot-relay-v1.${this.options.token}`]
    this.socket = protocols === undefined ? new WebSocket(base.toString()) : new WebSocket(base.toString(), protocols)
    this.socket.binaryType = 'arraybuffer'; this.readyState = false
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => { this.readyResolve = resolveReady; this.readyReject = rejectReady })
    // A reconnect can fail while no request is awaiting readiness. Attach a
    // rejection observer here so that background retry failures never become
    // process-level unhandled rejections; callers still receive the original
    // rejected promise from ready().
    void this.readyPromise.catch(() => undefined)
    const socket = this.socket
    socket.addEventListener('open', () => { this.reconnectBackoff = 500; socket.send(JSON.stringify({ type: 'hello', protocol: 1, channelId: this.options.channelId, role: this.options.role })) })
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        try { const value = JSON.parse(event.data) as { type?: string; protocol?: number; channelId?: string }; if (value.type === 'ready' && value.protocol === 1 && value.channelId === this.options.channelId) { this.readyState = true; this.readyResolve(); return } } catch { /* opaque application frame */ }
        const encoded = new TextEncoder().encode(event.data); for (const listener of this.listeners) listener(encoded); return
      }
      if (event.data instanceof ArrayBuffer) { const frame = new Uint8Array(event.data); for (const listener of this.listeners) listener(frame) }
    })
    socket.addEventListener('error', () => { if (!this.readyState) this.readyReject(new Error('relay WebSocket failed')) })
    socket.addEventListener('close', event => { if (this.socket !== socket) return; this.readyState = false; if (!this.closed && !this.readyState) { this.readyReject(new Error(`relay WebSocket closed: ${event.code}`)); this.scheduleReconnect() } })
  }
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return
    const delay = this.reconnectBackoff; this.reconnectBackoff = Math.min(this.reconnectBackoff * 2, 30_000)
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect() }, delay)
  }
  async ready(): Promise<void> {
    if (this.closed) throw new Error('relay channel is closed')
    if (!this.readyState && this.socket.readyState === WebSocket.CLOSED) { if (this.reconnectTimer !== undefined) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }; this.connect() }
    return this.readyPromise
  }
  send(frame: Uint8Array | string): void { if (this.socket.readyState !== WebSocket.OPEN) throw new Error('relay WebSocket is not open'); this.socket.send(frame) }
  onFrame(listener: RelayFrameListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  close(): void { this.closed = true; if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer); this.socket.close() }
}

interface PairingIdentity { privateKey: CryptoKey; publicKey: string }
function base64(value: ArrayBuffer | Uint8Array): string { let output = ''; for (const byte of new Uint8Array(value)) output += String.fromCharCode(byte); return btoa(output) }
function fromBase64(value: string): Uint8Array { const binary = atob(value); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index); return bytes }

interface RelayEnvelope { version: 1; iv: string; tag: string; ciphertext: string }
interface RelayControlResponse { kind: 'response'; id: string; status: number; contentType: string; body: string }

export interface RelayControlClientOptions extends RelayChannelOptions {
  encryptionKey: string
  accessToken?: string
  refreshToken?: string
  deviceId?: string
  onCredentialsChanged?: (credentials: RemoteCredentials) => void
}

class RelayHttpError extends Error {
  constructor(readonly status: number) { super(`remote relay request failed: HTTP ${status}`) }
}

/** Restricted API client over the E2E-encrypted outbound relay tunnel. */
export class RelayControlClient {
  private readonly channel: RemoteRelayChannel
  private accessToken?: string
  private refreshTokenValue?: string
  private deviceId?: string
  private refreshInFlight?: Promise<void>
  private readonly onCredentialsChanged?: (credentials: RemoteCredentials) => void
  private readonly keyPromise: Promise<CryptoKey>
  private readonly pending = new Map<string, { resolve: (value: RelayControlResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(options: RelayControlClientOptions) {
    if (options.token === undefined || !/^[A-Za-z0-9_-]{16,512}$/u.test(options.token)) throw new Error('relay control client requires a base64url relay token')
    if (options.encryptionKey.length < 16 || options.encryptionKey === options.token) throw new Error('relay control client requires a separate encryption key')
    this.channel = new RemoteRelayChannel(options); this.accessToken = options.accessToken; this.refreshTokenValue = options.refreshToken; this.deviceId = options.deviceId; this.onCredentialsChanged = options.onCredentialsChanged
    this.keyPromise = globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.encryptionKey)).then(value => globalThis.crypto.subtle.importKey('raw', value, 'AES-GCM', false, ['encrypt', 'decrypt']))
    this.channel.onFrame(frame => { void this.receive(frame) })
  }
  async serverInfo(): Promise<ServerInfo> { return this.get<ServerInfo>('/v1/server') }
  async pairingOffer(): Promise<PairingOffer> { return this.post<PairingOffer>('/v1/pairing/offer', {}) }
  async pair(code: string, name: string, offer?: PairingOffer): Promise<RemoteCredentials> {
    const value: Record<string, unknown> = { code, name }
    if (offer !== undefined) {
      const subtle = globalThis.crypto?.subtle
      if (subtle === undefined) throw new Error('WebCrypto is required for a remote pairing QR offer')
      const generated = await subtle.generateKey({ name: 'Ed25519' } as Algorithm, true, ['sign', 'verify']) as CryptoKeyPair
      const publicKey = base64(await subtle.exportKey('spki', generated.publicKey))
      const payload = new TextEncoder().encode(JSON.stringify({ version: 1, serverId: offer.serverId, serverPublicKey: offer.publicKey, offerId: offer.offerId, nonce: offer.nonce, identityPublicKey: publicKey }))
      const proof = base64(await subtle.sign({ name: 'Ed25519' } as Algorithm, generated.privateKey, payload))
      Object.assign(value, { offerId: offer.offerId, serverId: offer.serverId, serverPublicKey: offer.publicKey, identityPublicKey: publicKey, pairingProof: proof })
    }
    const result = await this.post<RemoteCredentials>('/v1/pair', value); this.setCredentials(result); return result
  }
  async sessions(): Promise<SessionSummary[]> { return this.get<SessionSummary[]>('/v1/sessions') }
  async tasks(): Promise<TaskSummary[]> { return this.get<TaskSummary[]>('/v1/tasks') }
  async permissions(sessionId?: string): Promise<PermissionSummary[]> { return this.get<PermissionSummary[]>(`/v1/permissions${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`) }
  async questions<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/questions') }
  async artifacts<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/artifacts') }
  async resources<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/resources') }
  async resource<T = unknown>(resourceId: string, operation = 'inspect', input: Record<string, string> = {}): Promise<T> { return this.get<T>(`/v1/resources/${encodeURIComponent(resourceId)}?${new URLSearchParams({ operation, ...input }).toString()}`) }
  async git<T = unknown>(cwd: string, path?: string): Promise<T> { return this.get<T>(`/v1/git?cwd=${encodeURIComponent(cwd)}${path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`) }
  async gitOpen(cwd: string, path: string): Promise<{ opened: boolean }> { return this.post('/v1/git/open', { cwd, path }) }
  async gitReveal(cwd: string, path: string): Promise<{ opened: boolean }> { return this.post('/v1/git/reveal', { cwd, path }) }
  async lineage<T = unknown>(sessionId: string): Promise<T[]> { return this.get<T[]>(`/v1/sessions/${encodeURIComponent(sessionId)}/lineage`) }
  async artifactRead(artifactId: string): Promise<Uint8Array> { const response = await this.request(`/v1/artifacts/${encodeURIComponent(artifactId)}`, 'GET'); return fromBase64(response.body) }
  async artifactOpen(artifactId: string): Promise<{ opened: boolean }> { return this.post(`/v1/artifacts/${encodeURIComponent(artifactId)}/open`, {}) }
  async artifactReveal(artifactId: string): Promise<{ opened: boolean }> { return this.post(`/v1/artifacts/${encodeURIComponent(artifactId)}/reveal`, {}) }
  async interrupt(sessionId: string): Promise<ControlResponse> { return this.control({ kind: 'interrupt', requestId: crypto.randomUUID(), sessionId }) }
  async permissionReply(permissionId: string, decision: 'allow' | 'deny'): Promise<ControlResponse> { return this.control({ kind: 'permission_reply', requestId: crypto.randomUUID(), permissionId, decision }) }
  async events(after = 0, generation?: string): Promise<EventPage> { return this.get<EventPage>(`/v1/events?after=${encodeURIComponent(String(after))}${generation === undefined ? '' : `&generation=${encodeURIComponent(generation)}`}`) }
  async control<T>(value: Record<string, unknown>): Promise<ControlResponse<T>> { return this.post<ControlResponse<T>>('/v1/control', value, false) }
  async streamEvents(options: EventStreamOptions): Promise<void> {
    let cursor = options.after ?? 0; let generation = options.generation
    while (!(options.signal?.aborted ?? false)) {
      try { const page = await this.events(cursor, generation); generation = page.generation; for (const event of page.events) { if (event.seq > cursor) { options.onEvent(event); cursor = event.seq } } } catch { /* reconnect below */ }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1_000); options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
    }
  }
  close(): void { this.channel.close(); for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('relay control client closed')) }; this.pending.clear() }
  private async get<T>(path: string): Promise<T> { const response = await this.request(path, 'GET'); return JSON.parse(new TextDecoder().decode(fromBase64(response.body))).value as T }
  private async post<T = unknown>(path: string, body: unknown, unwrap = true): Promise<T> { const response = await this.request(path, 'POST', body); const value = JSON.parse(new TextDecoder().decode(fromBase64(response.body))) as { value?: T }; return (unwrap ? value.value : value) as T }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown, canRefresh = true): Promise<RelayControlResponse> {
    await this.channel.ready(); const id = crypto.randomUUID(); const request = { kind: 'request' as const, id, createdAt: Date.now(), method, path, ...(this.accessToken === undefined ? {} : { authorization: `Bearer ${this.accessToken}` }), ...(body === undefined ? {} : { body }) }
    const key = await this.keyPromise; const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, new TextEncoder().encode(JSON.stringify(request)))); const tag = encrypted.slice(-16); const ciphertext = encrypted.slice(0, -16); const envelope: RelayEnvelope = { version: 1, iv: base64(iv), tag: base64(tag), ciphertext: base64(ciphertext) }
    try {
      return await new Promise<RelayControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id); reject(new Error('remote relay request timed out'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer });
      try { this.channel.send(JSON.stringify(envelope)) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
      })
    } catch (error) {
      if (canRefresh && error instanceof RelayHttpError && error.status === 401 && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { await this.refresh(); return this.request(path, method, body, false) }
      throw error
    }
  }
  private async refresh(): Promise<void> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      try {
        const response = await this.request('/v1/token/refresh', 'POST', { deviceId: this.deviceId, refreshToken: this.refreshTokenValue }, false)
        const result = JSON.parse(new TextDecoder().decode(fromBase64(response.body))) as { value?: RemoteCredentials }
        if (result.value?.token === undefined || result.value.refreshToken === undefined || result.value.device?.deviceId === undefined) throw new Error('remote relay refresh returned invalid credentials')
        this.accessToken = result.value.token; this.refreshTokenValue = result.value.refreshToken; this.deviceId = result.value.device.deviceId; this.onCredentialsChanged?.(result.value)
      } catch (error) {
        this.accessToken = undefined; this.refreshTokenValue = undefined; this.deviceId = undefined
        throw error
      }
    })().finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }
  private setCredentials(value: RemoteCredentials): void { this.accessToken = value.token; this.refreshTokenValue = value.refreshToken; this.deviceId = value.device.deviceId; this.onCredentialsChanged?.(value) }
  private async receive(frame: Uint8Array): Promise<void> {
    try { const envelope = JSON.parse(new TextDecoder().decode(frame)) as RelayEnvelope; const key = await this.keyPromise; const encrypted = new Uint8Array([...fromBase64(envelope.ciphertext), ...fromBase64(envelope.tag)]); const value = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) as unknown as BufferSource }, key, encrypted))) as RelayControlResponse; const pending = this.pending.get(value.id); if (pending === undefined) return; this.pending.delete(value.id); clearTimeout(pending.timer); if (value.status < 200 || value.status >= 300) pending.reject(new RelayHttpError(value.status)); else pending.resolve(value) } catch { /* malformed/foreign relay frames are ignored */ }
  }
}

export class RemoteControlClient {
  private readonly baseUrl: string
  private token?: string
  private refreshTokenValue?: string
  private deviceId?: string
  private pairingIdentity?: PairingIdentity
  private refreshInFlight?: Promise<void>
  private readonly onCredentialsChanged?: (credentials: RemoteCredentials) => void
  private readonly fetchImpl: typeof fetch
  constructor(options: RemoteClientOptions) { this.baseUrl = options.baseUrl.replace(/\/$/u, ''); this.token = options.token; this.refreshTokenValue = options.refreshToken; this.deviceId = options.deviceId; this.fetchImpl = options.fetchImpl ?? fetch; this.onCredentialsChanged = options.onCredentialsChanged }
  async serverInfo(): Promise<ServerInfo> { return this.get<ServerInfo>('/v1/server') }
  async sessions(): Promise<SessionSummary[]> { return this.get<SessionSummary[]>('/v1/sessions') }
  async tasks(): Promise<TaskSummary[]> { return this.get<TaskSummary[]>('/v1/tasks') }
  async permissions(sessionId?: string): Promise<PermissionSummary[]> { return this.get<PermissionSummary[]>(`/v1/permissions${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`) }
  async questions<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/questions') }
  async artifacts<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/artifacts') }
  async resources<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/resources') }
  async resource<T = unknown>(resourceId: string, operation = 'inspect', input: Record<string, string> = {}): Promise<T> { const params = new URLSearchParams({ operation, ...input }); return this.get<T>(`/v1/resources/${encodeURIComponent(resourceId)}?${params.toString()}`) }
  async git<T = unknown>(cwd: string, path?: string): Promise<T> { return this.get<T>(`/v1/git?cwd=${encodeURIComponent(cwd)}${path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`) }
  async gitOpen(cwd: string, path: string): Promise<{ opened: boolean }> { return this.post<{ opened: boolean }>('/v1/git/open', { cwd, path }) }
  async gitReveal(cwd: string, path: string): Promise<{ opened: boolean }> { return this.post<{ opened: boolean }>('/v1/git/reveal', { cwd, path }) }
  async lineage<T = unknown>(sessionId: string): Promise<T[]> { return this.get<T[]>(`/v1/sessions/${encodeURIComponent(sessionId)}/lineage`) }
  async artifactRead(artifactId: string): Promise<Uint8Array> {
    return this.artifactReadOnce(artifactId, true)
  }
  private async artifactReadOnce(artifactId: string, canRefresh: boolean): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, { headers: this.headers() })
    if (response.status === 401 && canRefresh && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { await this.refresh(); return this.artifactReadOnce(artifactId, false) }
    if (!response.ok) throw new Error(`artifact read failed: HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  async artifactOpen(artifactId: string): Promise<{ opened: boolean }> { return this.post<{ opened: boolean }>(`/v1/artifacts/${encodeURIComponent(artifactId)}/open`, {}) }
  async artifactReveal(artifactId: string): Promise<{ opened: boolean }> { return this.post<{ opened: boolean }>(`/v1/artifacts/${encodeURIComponent(artifactId)}/reveal`, {}) }
  async interrupt(sessionId: string): Promise<ControlResponse> { return this.control({ kind: 'interrupt', requestId: crypto.randomUUID(), sessionId }) }
  async permissionReply(permissionId: string, decision: 'allow' | 'deny'): Promise<ControlResponse> { return this.control({ kind: 'permission_reply', requestId: crypto.randomUUID(), permissionId, decision }) }
  async pairingOffer(): Promise<PairingOffer> { return this.post<PairingOffer>('/v1/pairing/offer', {}) }
  async pair(code: string, name: string, offer?: PairingOffer): Promise<{ device: DeviceInfo; token: string; refreshToken: string }> {
    const value: Record<string, unknown> = { code, name }
    if (offer !== undefined) {
      const subtle = globalThis.crypto?.subtle
      if (subtle === undefined) throw new Error('WebCrypto is required for a remote pairing QR offer')
      const generated = await subtle.generateKey({ name: 'Ed25519' } as Algorithm, true, ['sign', 'verify']) as CryptoKeyPair
      const publicKey = base64(await subtle.exportKey('spki', generated.publicKey))
      const payload = new TextEncoder().encode(JSON.stringify({ version: 1, serverId: offer.serverId, serverPublicKey: offer.publicKey, offerId: offer.offerId, nonce: offer.nonce, identityPublicKey: publicKey }))
      const proof = base64(await subtle.sign({ name: 'Ed25519' } as Algorithm, generated.privateKey, payload))
      this.pairingIdentity = { privateKey: generated.privateKey, publicKey }
      Object.assign(value, { offerId: offer.offerId, serverId: offer.serverId, serverPublicKey: offer.publicKey, identityPublicKey: publicKey, pairingProof: proof })
    }
    const result = await this.post<{ device: DeviceInfo; token: string; refreshToken: string }>('/v1/pair', value); this.setCredentials(result); return result
  }
  async events(after = 0, generation?: string): Promise<EventPage> { return this.get<EventPage>(`/v1/events?after=${encodeURIComponent(String(after))}${generation === undefined ? '' : `&generation=${encodeURIComponent(generation)}`}`) }
  async rotateDevice(deviceId: string): Promise<{ device: DeviceInfo; token: string; refreshToken: string }> { const result = await this.post<{ device: DeviceInfo; token: string; refreshToken: string }>(`/v1/devices/${encodeURIComponent(deviceId)}/rotate`, {}); this.setCredentials(result); return result }
  async streamEvents(options: EventStreamOptions): Promise<void> {
    let cursor = options.after ?? 0; let generation = options.generation; let backoffMs = 500; let refreshes = 0
    while (!(options.signal?.aborted ?? false)) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/events/stream?after=${encodeURIComponent(String(cursor))}${generation === undefined ? '' : `&generation=${encodeURIComponent(generation)}`}`, { headers: { ...this.headers(), 'last-event-id': String(cursor) }, signal: options.signal })
        if (response.status === 401 && refreshes === 0 && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { refreshes += 1; await this.refresh(); continue }
        if (response.status === 401) throw new Error('remote event stream authorization expired; pair the device again')
        if (!response.ok || response.body === null) throw new Error(`event stream failed: HTTP ${response.status}`)
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; backoffMs = 500; refreshes = 0
        while (true) {
          const next = await reader.read(); if (next.done) break
          buffer += decoder.decode(next.value, { stream: true }); const frames = buffer.split('\n\n'); buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6)
            if (data === undefined) continue
            if (frame.includes('event: reset-required')) { const reset = JSON.parse(data) as { generation?: string }; generation = reset.generation; cursor = 0; const page = await this.events(cursor, generation); for (const event of page.events) { if (event.seq > cursor) { options.onEvent(event); cursor = event.seq } }; continue }
            const event = JSON.parse(data) as ControlEvent
            if (event.seq > cursor + 1) {
              const catchUp = await this.events(cursor, generation)
              if (catchUp.resetRequired) { generation = catchUp.generation; cursor = 0 }
              for (const recovered of catchUp.events) { if (recovered.seq > cursor) { options.onEvent(recovered); cursor = recovered.seq } }
            }
            if (event.seq > cursor) { options.onEvent(event); cursor = event.seq }
          }
        }
      } catch (error) {
        if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') return
      }
      if (!(options.signal?.aborted ?? false)) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, backoffMs)
          options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    }
  }
  async control<T>(value: Record<string, unknown>): Promise<ControlResponse<T>> { return this.post<ControlResponse<T>>('/v1/control', value, false) }
  private async get<T>(path: string): Promise<T> { return this.request<T>('GET', path) }
  private async post<T>(path: string, value: unknown, unwrap = true): Promise<T> { return this.request<T>('POST', path, value, unwrap) }
  private async request<T>(method: 'GET' | 'POST', path: string, value?: unknown, unwrap = true, canRefresh = true): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, { method, headers: { ...this.headers(), ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
    if (response.status === 401 && canRefresh && path !== '/v1/token/refresh' && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { await this.refresh(); return this.request<T>(method, path, value, unwrap, false) }
    const body = await response.json() as { ok?: boolean; value?: T; error?: { message?: string } }
    if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? `remote request failed: HTTP ${response.status}`)
    return (unwrap ? body.value : body) as T
  }
  private async refresh(): Promise<void> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/token/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: this.deviceId, refreshToken: this.refreshTokenValue }) })
      const body = await response.json() as { ok?: boolean; value?: RemoteCredentials; error?: { message?: string } }
      if (!response.ok || body.ok !== true || body.value === undefined) { this.clearCredentials(); throw new Error(body.error?.message ?? 'remote token refresh failed') }
      this.setCredentials(body.value)
    })()
    try { await this.refreshInFlight } finally { this.refreshInFlight = undefined }
  }
  private setCredentials(value: RemoteCredentials): void { this.deviceId = value.device.deviceId; this.token = value.token; this.refreshTokenValue = value.refreshToken; this.onCredentialsChanged?.(value) }
  private clearCredentials(): void { this.token = undefined; this.refreshTokenValue = undefined; this.deviceId = undefined }
  private headers(): HeadersInit { return this.token === undefined ? {} : { authorization: `Bearer ${this.token}` } }
}
