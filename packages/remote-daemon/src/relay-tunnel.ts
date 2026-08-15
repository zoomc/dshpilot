import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'

const MAX_BODY = 4 * 1024 * 1024
const ALLOWED_PATH = /^\/v1\/(server|runtime|sessions(?:\/[^/]+\/lineage)?|tasks|permissions|questions|artifacts(?:\/[^/]+)?(?:\/(?:open|reveal))?|resources(?:\/[^/]+)?|git|events|pair|pairing\/offer|token\/refresh|control)$/u
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface RelayEnvelope { version: 1; iv: string; tag: string; ciphertext: string }
interface RelayRequest { kind: 'request'; id: string; createdAt: number; method: 'GET' | 'POST'; path: string; authorization?: string; body?: unknown }
interface RelayResponse { kind: 'response'; id: string; status: number; contentType: string; body: string }

function keyFor(encryptionKey: string): Buffer { return createHash('sha256').update(encryptionKey).digest() }
function seal(encryptionKey: string, value: unknown): RelayEnvelope { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyFor(encryptionKey), iv); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]); return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } }
function open(encryptionKey: string, value: RelayEnvelope): RelayRequest | RelayResponse { if (value.version !== 1) throw new Error('relay envelope version is invalid'); const decipher = createDecipheriv('aes-256-gcm', keyFor(encryptionKey), Buffer.from(value.iv, 'base64')); decipher.setAuthTag(Buffer.from(value.tag, 'base64')); const body = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]); if (body.byteLength > MAX_BODY) throw new Error('relay message is too large'); return JSON.parse(body.toString('utf8')) as RelayRequest | RelayResponse }
function relayUrl(base: string, channelId: string): string { const url = new URL(base); url.pathname = `${url.pathname.replace(/\/$/u, '')}/v1/relay/${encodeURIComponent(channelId)}`; return url.toString() }
function hello(channelId: string): string { return JSON.stringify({ type: 'hello', protocol: 1, channelId, role: 'desktop' }) }
function allowedPath(value: string): boolean {
  try {
    const url = new URL(value, 'http://dshpilot.invalid')
    return url.origin === 'http://dshpilot.invalid' && url.username === '' && url.password === '' && ALLOWED_PATH.test(url.pathname)
  } catch { return false }
}

export interface RestrictedRelayTunnelOptions { relayUrl: string; channelId: string; token: string; encryptionKey: string; localBaseUrl: string }

/** Desktop-side outbound connector for the self-hosted blind relay. */
export class RestrictedRelayTunnel {
  private stopping = false
  private socket?: WebSocket
  private readonly url: string
  private readonly seenRequests = new Map<string, number>()
  constructor(private readonly options: RestrictedRelayTunnelOptions) {
    if (!/^[A-Za-z0-9_-]{16,512}$/u.test(options.token)) throw new Error('relay tunnel token must be 16-512 base64url characters')
    if (options.encryptionKey.length < 16 || options.encryptionKey === options.token) throw new Error('relay tunnel requires a separate encryption key')
    this.url = relayUrl(options.relayUrl, options.channelId)
  }
  start(): void { void this.run() }
  stop(): void { this.stopping = true; this.socket?.close(1000, 'stopping') }
  private async run(): Promise<void> {
    let backoff = 500
    while (!this.stopping) {
      await new Promise<void>(resolve => {
        const socket = new WebSocket(this.url, [`dshpilot-relay-v1.${this.options.token}`]); this.socket = socket
        socket.once('open', () => { backoff = 500; socket.send(hello(this.options.channelId)) })
        socket.on('message', data => { const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer); const text = bytes.toString('utf8'); if (text.includes('"type":"ready"')) return; void this.handle(text).catch(() => socket.close(1008, 'invalid restricted relay request')) })
        socket.once('close', () => { this.socket = undefined; resolve() }); socket.once('error', () => { socket.close() })
      })
      if (!this.stopping) { await sleep(backoff); backoff = Math.min(backoff * 2, 30_000) }
    }
  }
  private async handle(text: string): Promise<void> {
    const request = open(this.options.encryptionKey, JSON.parse(text) as RelayEnvelope) as RelayRequest
    if (request.kind !== 'request' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(request.id) || !Number.isSafeInteger(request.createdAt) || Math.abs(Date.now() - request.createdAt) > 60_000 || (request.method !== 'GET' && request.method !== 'POST') || !allowedPath(request.path)) throw new Error('restricted relay request is invalid')
    const now = Date.now(); for (const [id, at] of this.seenRequests) if (now - at > 60_000) this.seenRequests.delete(id)
    if (this.seenRequests.has(request.id)) throw new Error('restricted relay request replay detected')
    if (this.seenRequests.size >= 10_000) throw new Error('restricted relay request window is full')
    this.seenRequests.set(request.id, now)
    const response = await fetch(`${this.options.localBaseUrl}${request.path}`, { method: request.method, headers: { ...(request.authorization === undefined ? {} : { authorization: request.authorization }), ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
    const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > MAX_BODY) throw new Error('local control response is too large')
    const result: RelayResponse = { kind: 'response', id: request.id, status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(bytes).toString('base64') }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(seal(this.options.encryptionKey, result)))
  }
}
