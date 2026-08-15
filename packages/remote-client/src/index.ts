import type { ControlEvent, ControlResponse, DeviceInfo, EventPage, PairingOffer, PermissionSummary, ServerInfo, TaskSummary, SessionSummary } from '@dshpilot/control-contracts'

export interface RemoteClientOptions { baseUrl: string; token?: string; refreshToken?: string; deviceId?: string; fetchImpl?: typeof fetch }
export interface EventStreamOptions { after?: number; generation?: string; signal?: AbortSignal; onEvent: (event: ControlEvent) => void }

interface PairingIdentity { privateKey: CryptoKey; publicKey: string }
function base64(value: ArrayBuffer): string { let output = ''; for (const byte of new Uint8Array(value)) output += String.fromCharCode(byte); return btoa(output) }

export class RemoteControlClient {
  private readonly baseUrl: string
  private token?: string
  private refreshTokenValue?: string
  private deviceId?: string
  private pairingIdentity?: PairingIdentity
  private readonly fetchImpl: typeof fetch
  constructor(options: RemoteClientOptions) { this.baseUrl = options.baseUrl.replace(/\/$/u, ''); this.token = options.token; this.refreshTokenValue = options.refreshToken; this.deviceId = options.deviceId; this.fetchImpl = options.fetchImpl ?? fetch }
  async serverInfo(): Promise<ServerInfo> { return this.get<ServerInfo>('/v1/server') }
  async sessions(): Promise<SessionSummary[]> { return this.get<SessionSummary[]>('/v1/sessions') }
  async tasks(): Promise<TaskSummary[]> { return this.get<TaskSummary[]>('/v1/tasks') }
  async permissions(sessionId?: string): Promise<PermissionSummary[]> { return this.get<PermissionSummary[]>(`/v1/permissions${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`) }
  async artifacts<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/artifacts') }
  async resources<T = unknown>(): Promise<T[]> { return this.get<T[]>('/v1/resources') }
  async git<T = unknown>(cwd: string, path?: string): Promise<T> { return this.get<T>(`/v1/git?cwd=${encodeURIComponent(cwd)}${path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`) }
  async lineage<T = unknown>(sessionId: string): Promise<T[]> { return this.get<T[]>(`/v1/sessions/${encodeURIComponent(sessionId)}/lineage`) }
  async artifactRead(artifactId: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}`, { headers: this.headers() })
    if (response.status === 401 && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { await this.refresh(); return this.artifactRead(artifactId) }
    if (!response.ok) throw new Error(`artifact read failed: HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
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
    let cursor = options.after ?? 0; let generation = options.generation; let backoffMs = 500
    while (!(options.signal?.aborted ?? false)) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/events/stream?after=${encodeURIComponent(String(cursor))}${generation === undefined ? '' : `&generation=${encodeURIComponent(generation)}`}`, { headers: { ...this.headers(), 'last-event-id': String(cursor) }, signal: options.signal })
        if (response.status === 401 && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { await this.refresh(); continue }
        if (!response.ok || response.body === null) throw new Error(`event stream failed: HTTP ${response.status}`)
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; backoffMs = 500
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
  private async request<T>(method: 'GET' | 'POST', path: string, value?: unknown, unwrap = true): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, { method, headers: { ...this.headers(), ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
    if (response.status === 401 && path !== '/v1/token/refresh' && this.refreshTokenValue !== undefined && this.deviceId !== undefined) { await this.refresh(); return this.request<T>(method, path, value, unwrap) }
    const body = await response.json() as { ok?: boolean; value?: T; error?: { message?: string } }
    if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? `remote request failed: HTTP ${response.status}`)
    return (unwrap ? body.value : body) as T
  }
  private async refresh(): Promise<void> { const response = await this.fetchImpl(`${this.baseUrl}/v1/token/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: this.deviceId, refreshToken: this.refreshTokenValue }) }); const body = await response.json() as { ok?: boolean; value?: { device: DeviceInfo; token: string; refreshToken: string }; error?: { message?: string } }; if (!response.ok || body.ok !== true || body.value === undefined) throw new Error(body.error?.message ?? 'remote token refresh failed'); this.setCredentials(body.value) }
  private setCredentials(value: { device: DeviceInfo; token: string; refreshToken: string }): void { this.deviceId = value.device.deviceId; this.token = value.token; this.refreshTokenValue = value.refreshToken }
  private headers(): HeadersInit { return this.token === undefined ? {} : { authorization: `Bearer ${this.token}` } }
}
