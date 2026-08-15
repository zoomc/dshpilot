import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer as createSecureServer } from 'node:https'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

const PROTOCOL = 'dshpilot-relay-v1'
const MAX_CHANNELS = 1024
const MAX_PEERS = 2
const MAX_PAYLOAD = 4 * 1024 * 1024
const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u

export interface RemoteRelayServerOptions {
  host?: string
  port?: number
  /** A bearer-like token shared by the operator's desktop and client. */
  token?: string
  /** Optional path prefix, useful behind a reverse proxy. */
  pathPrefix?: string
  maxChannels?: number
  allowedHosts?: readonly string[]
  allowedOrigins?: readonly string[]
  tls?: { key: string | Buffer; cert: string | Buffer }
}

export interface RemoteRelayAddress { host: string; port: number }

interface Peer { ws: WebSocket; role: 'desktop' | 'client' }
interface Hello { type: 'hello'; protocol: 1; channelId: string; role: 'desktop' | 'client' }

function bounded(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) }
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
  private readonly channels = new Map<string, Map<string, Peer>>()
  private readonly http: Server
  private readonly sockets: WebSocketServer
  private addressValue?: RemoteRelayAddress

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
    return this.addressValue
  }

  async stop(): Promise<void> {
    for (const peers of this.channels.values()) for (const peer of peers.values()) peer.ws.close(1001, 'relay shutting down')
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
      const peers = this.channels.get(channelId) ?? new Map<string, Peer>()
      if (!this.channels.has(channelId) && this.channels.size >= (this.options.maxChannels ?? MAX_CHANNELS)) { socket.destroy(); return }
      if (peers.size >= MAX_PEERS) { socket.destroy(); return }
      this.sockets.handleUpgrade(request, socket, head, ws => this.accept(channelId, ws))
    } catch { socket.destroy() }
  }

  private accept(channelId: string, ws: WebSocket): void {
    let hello: Hello | undefined
    const peers = this.channels.get(channelId) ?? new Map<string, Peer>()
    const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const cleanup = (): void => {
      if (hello === undefined) clearTimeout(handshakeTimer)
      const activePeers = this.channels.get(channelId) ?? peers
      activePeers.delete(connectionId)
      if (activePeers.size === 0) this.channels.delete(channelId)
    }
    const fail = (message: string): void => { ws.close(1008, message); cleanup() }
    const handshakeTimer = setTimeout(() => { if (hello === undefined) fail('relay hello timeout') }, 10_000)
    let rateWindow = Date.now(); let rateCount = 0
    const onMessage = (data: RawData): void => {
      try {
        if (Date.now() - rateWindow >= 1_000) { rateWindow = Date.now(); rateCount = 0 }
        rateCount += 1; if (rateCount > 120) throw new Error('relay rate limit exceeded')
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        if (bytes.byteLength > MAX_PAYLOAD) throw new Error('relay frame exceeds 4 MiB')
        if (hello === undefined) {
          const value = JSON.parse(bytes.toString('utf8')) as Partial<Hello>
          if (value.type !== 'hello' || value.protocol !== 1 || value.channelId !== channelId || (value.role !== 'desktop' && value.role !== 'client')) throw new Error('relay hello is invalid')
          const activePeers = this.channels.get(channelId) ?? peers
          if ([...activePeers.values()].some(peer => peer.role === value.role)) throw new Error('relay role is already connected')
          hello = value as Hello; clearTimeout(handshakeTimer); activePeers.set(connectionId, { ws, role: hello.role }); this.channels.set(channelId, activePeers)
          ws.send(JSON.stringify({ type: 'ready', protocol: 1, channelId, role: hello.role }))
          return
        }
        const activePeers = this.channels.get(channelId) ?? peers
        for (const [id, peer] of activePeers) if (id !== connectionId && peer.ws.readyState === peer.ws.OPEN) peer.ws.send(bytes)
      } catch { fail('invalid relay frame') }
    }
    ws.on('message', onMessage); ws.on('close', cleanup); ws.on('error', cleanup)
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
export const relayProtocol = PROTOCOL
