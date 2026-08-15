import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer as createSecureServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

const PROTOCOL = 'dshpilot-relay-v1'
const MAX_CHANNELS = 1024
const MAX_PEERS = 2
const MAX_PAYLOAD = 4 * 1024 * 1024
const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u

export interface RemoteRelayServerOptions {
  host?: string
  port?: number
  /** A bearer-like token shared by the operator's desktop and client. */
  token?: string
  /** Optional path prefix, useful behind a reverse proxy. */
  pathPrefix?: string
  maxChannels?: number
  /** Maximum lifetime of a channel, even if both peers stay connected. */
  channelMaxAgeMs?: number
  /** Remove an otherwise connected channel after this much inactivity. */
  channelIdleTimeoutMs?: number
  /** Time allowed for a peer to complete the hello+authenticate handshake. */
  handshakeTimeoutMs?: number
  allowedHosts?: readonly string[]
  allowedOrigins?: readonly string[]
  tls?: { key: string | Buffer; cert: string | Buffer }
}

export interface RemoteRelayAddress { host: string; port: number }

interface Peer { ws: WebSocket; role: 'desktop' | 'client' }
interface Channel { peers: Map<string, Peer>; connectingRoles: Set<'desktop' | 'client'>; createdAt: number; lastActivityAt: number; nonce: string }
interface Hello { type: 'hello'; protocol: 1; channelId: string; role: 'desktop' | 'client' }
interface Authenticate { type: 'authenticate'; hmac: string }

function bounded(value: string): boolean { return CHANNEL_ID_PATTERN.test(value) }
function reject(response: ServerResponse, status: number, message: string): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ok: false, error: message })) }
function tokenFrom(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length)
  const protocols = request.headers['sec-websocket-protocol']
  if (typeof protocols !== 'string') return undefined
  const value = protocols.split(',').map(item => item.trim()).find(item => item.startsWith(`${PROTOCOL}.`))
  return value?.slice(PROTOCOL.length + 1)
}
function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const left = createHash('sha256').update(expected).digest(); const right = createHash('sha256').update(actual).digest()
  return timingSafeEqual(left, right)
}
function channelHmac(token: string, channelId: string, nonce: string, role: 'desktop' | 'client'): string {
  return createHmac('sha256', token).update(`${channelId}:${nonce}:${role}`).digest('base64')
}
function loopbackHost(value: string): boolean { return value === '127.0.0.1' || value === '::1' || value === 'localhost' || value === '::ffff:127.0.0.1' }
function channelFromPath(pathname: string, prefix: string): string | undefined {
  const base = `${prefix.replace(/\/$/u, '')}/v1/relay/`
  if (!pathname.startsWith(base)) return undefined
  const channel = decodeURIComponent(pathname.slice(base.length))
  return bounded(channel) ? channel : undefined
}

/**
 * A deliberately blind relay. It authenticates channel membership, then
 * forwards opaque encrypted relay frames without parsing or persisting them.
 * Desktop and browser peers retain the E2E keys; the relay is not an RPC
 * server and cannot inspect Harness sessions, prompts, or credentials.
 */
export class RemoteRelayServer {
  private readonly options: Required<Pick<RemoteRelayServerOptions, 'host' | 'port' | 'pathPrefix'>> & RemoteRelayServerOptions
  private readonly channels = new Map<string, Channel>()
  private readonly http: Server
  private readonly sockets: WebSocketServer
  private addressValue?: RemoteRelayAddress
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor(options: RemoteRelayServerOptions = {}) {
    this.options = { host: '127.0.0.1', port: 0, pathPrefix: '', ...options }
    if (this.options.token === undefined || !RELAY_TOKEN_PATTERN.test(this.options.token)) throw new Error('relay token is required and must be 16-512 base64url characters')
    if (!loopbackHost(this.options.host) && this.options.tls === undefined) throw new Error('non-loopback relay mode requires TLS')
    this.http = this.options.tls === undefined ? createServer((request, response) => this.handleHttp(request, response)) : createSecureServer(this.options.tls, (request, response) => this.handleHttp(request, response))
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
    this.http.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
  }

  async start(): Promise<RemoteRelayAddress> {
    await new Promise<void>((resolve, rejectPromise) => { this.http.once('error', rejectPromise); this.http.listen(this.options.port, this.options.host, () => resolve()) })
    const address = this.http.address()
    if (address === null || typeof address === 'string') throw new Error('relay address unavailable')
    this.addressValue = { host: address.address, port: address.port }
    this.sweepTimer = setInterval(() => this.sweepChannels(), 60_000)
    return this.addressValue
  }

  async stop(): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    for (const channel of this.channels.values()) for (const peer of channel.peers.values()) peer.ws.close(1001, 'relay shutting down')
    this.channels.clear(); this.sockets.close()
    await new Promise<void>(resolve => this.http.close(() => resolve()))
  }

  address(): RemoteRelayAddress | undefined { return this.addressValue }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const prefix = this.options.pathPrefix ?? ''
    if (request.url === `${prefix.replace(/\/$/u, '')}/health`) { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ok: true, protocol: PROTOCOL, channels: this.channels.size })); return }
    reject(response, 404, 'not found')
  }

  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      const channelId = channelFromPath(url.pathname, this.options.pathPrefix ?? '')
      const requestHost = url.hostname.toLowerCase()
      const allowedHosts = new Set([this.options.host.toLowerCase(), ...(this.options.allowedHosts ?? []).map(value => value.toLowerCase()), '127.0.0.1', 'localhost', '::1'])
      if (channelId === undefined || !allowedHosts.has(requestHost) && !(loopbackHost(this.options.host) && loopbackHost(requestHost)) || !tokenMatches(this.options.token as string, tokenFrom(request))) { socket.destroy(); return }
      const origin = request.headers.origin
      if (origin !== undefined) {
        const parsedOrigin = new URL(origin)
        const scheme = (request.socket as import('node:tls').TLSSocket).encrypted ? 'https:' : 'http:'
        const sameOrigin = parsedOrigin.origin === new URL(`${scheme}//${request.headers.host ?? ''}`).origin
        if (!(this.options.allowedOrigins?.includes(origin) ?? false) && !sameOrigin) { socket.destroy(); return }
      }
      const existing = this.channels.get(channelId)
      if (existing !== undefined && this.channelExpired(existing)) {
        for (const peer of existing.peers.values()) peer.ws.close(1001, 'relay channel expired')
        this.channels.delete(channelId)
      }
      const peers = this.channels.get(channelId)?.peers ?? new Map<string, Peer>()
      if (!this.channels.has(channelId) && this.channels.size >= (this.options.maxChannels ?? MAX_CHANNELS)) { socket.destroy(); return }
      if (peers.size >= MAX_PEERS) { socket.destroy(); return }
      this.sockets.handleUpgrade(request, socket, head, ws => this.accept(channelId, ws))
    } catch { socket.destroy() }
  }

  private accept(channelId: string, ws: WebSocket): void {
    let hello: Hello | undefined
    let role: 'desktop' | 'client' | undefined
    let authenticated = false
    const isNew = !this.channels.has(channelId)
    const channel: Channel = isNew
      ? { peers: new Map<string, Peer>(), connectingRoles: new Set(), createdAt: Date.now(), lastActivityAt: Date.now(), nonce: randomBytes(32).toString('base64url') }
      : this.channels.get(channelId)!
    const peers = channel.peers
    if (!isNew && !this.channels.has(channelId)) this.channels.set(channelId, channel)
    this.channels.set(channelId, channel)
    const now = Date.now()
    channel.lastActivityAt = now
    const connectionId = `${Date.now()}-${randomUUID()}`
    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      clearTimeout(handshakeTimer)
      if (role !== undefined) channel.connectingRoles.delete(role)
      const activePeers = this.channels.get(channelId)?.peers ?? peers
      activePeers.delete(connectionId)
      if (activePeers.size === 0 && channel.connectingRoles.size === 0) this.channels.delete(channelId)
    }
    const fail = (message: string): void => { ws.close(1008, message); cleanup() }
    const handshakeTimer = setTimeout(() => { if (!authenticated) fail('relay handshake timeout') }, this.options.handshakeTimeoutMs ?? 10_000)
    let rateWindow = Date.now(); let rateCount = 0
    const onMessage = (data: RawData): void => {
      try {
        if (Date.now() - rateWindow >= 1_000) { rateWindow = Date.now(); rateCount = 0 }
        rateCount += 1; if (rateCount > 120) throw new Error('relay rate limit exceeded')
        channel.lastActivityAt = Date.now()
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        if (bytes.byteLength > MAX_PAYLOAD) throw new Error('relay frame exceeds 4 MiB')
        const text = bytes.toString('utf8')
        if (hello === undefined) {
          const value = JSON.parse(text) as Partial<Hello>
          if (value.type !== 'hello' || value.protocol !== 1 || value.channelId !== channelId || (value.role !== 'desktop' && value.role !== 'client')) throw new Error('relay hello is invalid')
          if (peers.has(value.role) || channel.connectingRoles.has(value.role)) throw new Error('relay role is already connected')
          hello = value as Hello; role = hello.role; channel.connectingRoles.add(hello.role)
          ws.send(JSON.stringify({ type: 'ready', protocol: 1, channelId, role: hello.role, nonce: channel.nonce }))
          return
        }
        if (!authenticated) {
          const value = JSON.parse(text) as Partial<Authenticate>
          if (value.type !== 'authenticate' || typeof value.hmac !== 'string' || role === undefined) throw new Error('relay authenticate is required')
          const expected = Buffer.from(channelHmac(this.options.token as string, channelId, channel.nonce, role))
          const supplied = Buffer.from(value.hmac)
          if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('relay authentication failed')
          authenticated = true; peers.set(connectionId, { ws, role }); clearTimeout(handshakeTimer)
          ws.send(JSON.stringify({ type: 'authenticated', protocol: 1, channelId, role }))
          return
        }
        for (const [id, peer] of peers) if (id !== connectionId && peer.ws.readyState === peer.ws.OPEN) peer.ws.send(bytes)
      } catch { fail('invalid relay frame') }
    }
    ws.on('message', onMessage); ws.on('close', cleanup); ws.on('error', cleanup)
  }

  private channelExpired(channel: Channel): boolean {
    const now = Date.now()
    return now - channel.createdAt > (this.options.channelMaxAgeMs ?? 24 * 60 * 60 * 1000)
      || now - channel.lastActivityAt > (this.options.channelIdleTimeoutMs ?? 60 * 60 * 1000)
  }

  private sweepChannels(): void {
    for (const [channelId, channel] of this.channels) {
      if (!this.channelExpired(channel)) continue
      for (const peer of channel.peers.values()) peer.ws.close(1001, 'relay channel expired')
      this.channels.delete(channelId)
    }
  }
}

export interface RelayPeerOptions { url: string; channelId: string; role: 'desktop' | 'client'; token?: string }

/** Browser/Node peer helper. Payloads are intentionally opaque to this package. */
export function relayWebSocketUrl(options: RelayPeerOptions): string {
  const url = new URL(options.url)
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/v1/relay/${encodeURIComponent(options.channelId)}`
  return url.toString()
}

export function relayHello(options: RelayPeerOptions): string { return JSON.stringify({ type: 'hello', protocol: 1, channelId: options.channelId, role: options.role }) }
export function relayAuthenticate(options: RelayPeerOptions, nonce: string): string { return JSON.stringify({ type: 'authenticate', hmac: channelHmac(options.token ?? '', options.channelId, nonce, options.role) }) }
export const relayProtocol = PROTOCOL
export const relayChannelIdPattern = CHANNEL_ID_PATTERN
