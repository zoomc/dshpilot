import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto'

export interface RelayKeyPair {
  privateKey: KeyObject
  publicKey: string
}

export interface RelayIdentity {
  privateKey: KeyObject
  publicKey: string
}

export type RelayPeerRole = 'client' | 'server'

export interface RelayHandshake {
  version: 1
  sessionId: string
  x25519PublicKey: string
  identityPublicKey: string
  deviceId: string
  serverId: string
  serverPublicKey: string
  role: RelayPeerRole
  workspaceId?: string
  signature: string
}

export interface RelayHandshakeOptions {
  sessionId: string
  x25519PublicKey: string
  deviceId: string
  serverId: string
  serverPublicKey: string
  role: RelayPeerRole
  workspaceId?: string
}

export interface RelayHandshakeExpectations {
  expectedIdentityPublicKey?: string
  expectedDeviceId?: string
  expectedServerId?: string
  expectedServerPublicKey?: string
  expectedRole?: RelayPeerRole
  expectedWorkspaceId?: string
}

export interface RelayReady {
  type: 'ready'
  version: 1
  sessionId: string
  deviceId: string
  serverId: string
  serverPublicKey: string
  signature: string
}

export function createRelayIdentity(): RelayIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

function identityPublicKey(value: string): KeyObject {
  return createPublicKey({ key: decodeBase64(value, 'identity public key', 256), format: 'der', type: 'spki' })
}

function handshakePayload(options: RelayHandshakeOptions & { identityPublicKey: string }): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    sessionId: options.sessionId,
    x25519PublicKey: options.x25519PublicKey,
    identityPublicKey: options.identityPublicKey,
    deviceId: options.deviceId,
    serverId: options.serverId,
    serverPublicKey: options.serverPublicKey,
    role: options.role,
    workspaceId: options.workspaceId ?? null,
  }))
}

export function signRelayHandshake(identity: RelayIdentity, options: RelayHandshakeOptions): RelayHandshake
export function signRelayHandshake(identity: RelayIdentity, sessionId: string, x25519PublicKey: string): RelayHandshake
export function signRelayHandshake(identity: RelayIdentity, optionsOrSessionId: RelayHandshakeOptions | string, legacyX25519PublicKey?: string): RelayHandshake {
  const options: RelayHandshakeOptions = typeof optionsOrSessionId === 'string'
    ? { sessionId: optionsOrSessionId, x25519PublicKey: legacyX25519PublicKey ?? '', deviceId: 'legacy-device', serverId: 'legacy-server', serverPublicKey: identity.publicKey, role: 'client' }
    : optionsOrSessionId
  const value = { ...options, version: 1 as const, identityPublicKey: identity.publicKey }
  return { ...value, signature: sign(null, handshakePayload(value), identity.privateKey).toString('base64') }
}

export function verifyRelayHandshake(handshake: RelayHandshake, expected?: RelayHandshakeExpectations | string): void {
  const expectations: RelayHandshakeExpectations = typeof expected === 'string' ? { expectedIdentityPublicKey: expected } : expected ?? {}
  if (handshake.version !== 1 || !isBoundedIdentifier(handshake.sessionId) || !isBoundedIdentifier(handshake.deviceId) || !isBoundedIdentifier(handshake.serverId)
    || (handshake.role !== 'client' && handshake.role !== 'server') || handshake.workspaceId !== undefined && !isBoundedIdentifier(handshake.workspaceId)
    || typeof handshake.x25519PublicKey !== 'string' || typeof handshake.identityPublicKey !== 'string' || typeof handshake.serverPublicKey !== 'string' || typeof handshake.signature !== 'string') {
    throw new Error('relay handshake is invalid')
  }
  if (expectations.expectedIdentityPublicKey !== undefined && handshake.identityPublicKey !== expectations.expectedIdentityPublicKey) throw new Error('relay handshake identity is not trusted')
  if (expectations.expectedDeviceId !== undefined && handshake.deviceId !== expectations.expectedDeviceId) throw new Error('relay handshake device is not authorized')
  if (expectations.expectedServerId !== undefined && handshake.serverId !== expectations.expectedServerId) throw new Error('relay handshake server is not trusted')
  if (expectations.expectedServerPublicKey !== undefined && handshake.serverPublicKey !== expectations.expectedServerPublicKey) throw new Error('relay handshake server key is not trusted')
  if (expectations.expectedRole !== undefined && handshake.role !== expectations.expectedRole) throw new Error('relay handshake role is not authorized')
  if (expectations.expectedWorkspaceId !== undefined && handshake.workspaceId !== expectations.expectedWorkspaceId) throw new Error('relay handshake workspace is not authorized')
  publicKey(handshake.x25519PublicKey)
  identityPublicKey(handshake.identityPublicKey)
  identityPublicKey(handshake.serverPublicKey)
  const payload = handshakePayload(handshake)
  if (!verifySignature(null, payload, identityPublicKey(handshake.identityPublicKey), decodeBase64(handshake.signature, 'relay handshake signature', 256))) throw new Error('relay handshake identity signature mismatch')
}

function readyPayload(value: Pick<RelayReady, 'sessionId' | 'deviceId' | 'serverId' | 'serverPublicKey'>): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, ...value }))
}

export function signRelayReady(serverIdentity: RelayIdentity, handshake: RelayHandshake): RelayReady {
  if (serverIdentity.publicKey !== handshake.serverPublicKey) throw new Error('relay ready server key does not match handshake')
  const value = { sessionId: handshake.sessionId, deviceId: handshake.deviceId, serverId: handshake.serverId, serverPublicKey: serverIdentity.publicKey }
  return { type: 'ready', version: 1, ...value, signature: sign(null, readyPayload(value), serverIdentity.privateKey).toString('base64') }
}

export function verifyRelayReady(ready: RelayReady, handshake: RelayHandshake, expectedServerPublicKey?: string): void {
  if (ready.type !== 'ready' || ready.version !== 1 || ready.sessionId !== handshake.sessionId || ready.deviceId !== handshake.deviceId || ready.serverId !== handshake.serverId
    || ready.serverPublicKey !== handshake.serverPublicKey || expectedServerPublicKey !== undefined && ready.serverPublicKey !== expectedServerPublicKey) throw new Error('relay ready message is not bound to the handshake')
  if (!verifySignature(null, readyPayload(ready), identityPublicKey(ready.serverPublicKey), decodeBase64(ready.signature, 'relay ready signature', 256))) throw new Error('relay ready server signature mismatch')
}

export interface PairingProofInput {
  serverId: string
  serverPublicKey: string
  offerId: string
  nonce: string
  identityPublicKey: string
}

function pairingProofPayload(input: PairingProofInput): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, ...input }))
}

export function signPairingProof(identity: RelayIdentity, input: Omit<PairingProofInput, 'identityPublicKey'>): string {
  return sign(null, pairingProofPayload({ ...input, identityPublicKey: identity.publicKey }), identity.privateKey).toString('base64')
}

export function verifyPairingProof(input: PairingProofInput, proof: string): void {
  identityPublicKey(input.identityPublicKey)
  if (!verifySignature(null, pairingProofPayload(input), identityPublicKey(input.identityPublicKey), decodeBase64(proof, 'pairing proof', 256))) throw new Error('pairing identity proof is invalid')
}

export interface EncryptedRelayPacket {
  version: 1
  nonce: string
  iv: string
  tag: string
  ciphertext: string
  aad?: string
}

export interface EncryptedRelayFrame extends EncryptedRelayPacket {
  sessionId: string
  direction: 'client_to_server' | 'server_to_client'
  frameSeq: number
}

export function createRelayKeyPair(): RelayKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

function publicKey(value: string): KeyObject {
  return createPublicKey({ key: decodeBase64(value, 'relay public key', 256), format: 'der', type: 'spki' })
}

function relayKey(privateKey: KeyObject, peerPublicKey: string, nonce: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: publicKey(peerPublicKey) })
  return Buffer.from(hkdfSync('sha256', shared, nonce, Buffer.from('dshpilot-relay-v1'), 32))
}

export function encryptRelayPayload(privateKey: KeyObject, peerPublicKey: string, plaintext: Uint8Array, aad?: Uint8Array): EncryptedRelayPacket {
  if (plaintext.byteLength > 4 * 1024 * 1024) throw new Error('relay frame exceeds 4 MiB')
  const nonce = randomBytes(32)
  const key = relayKey(privateKey, peerPublicKey, nonce)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  if (aad !== undefined) cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    version: 1,
    nonce: nonce.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    ...(aad === undefined ? {} : { aad: Buffer.from(aad).toString('base64') }),
  }
}

export function decryptRelayPayload(privateKey: KeyObject, peerPublicKey: string, packet: EncryptedRelayPacket): Uint8Array {
  assertEncryptedRelayPacket(packet)
  const nonce = decodeBase64(packet.nonce, 'relay nonce', 32)
  const key = relayKey(privateKey, peerPublicKey, nonce)
  const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(packet.iv, 'relay iv', 12))
  if (packet.aad !== undefined) decipher.setAAD(decodeBase64(packet.aad, 'relay aad', 4 * 1024))
  decipher.setAuthTag(decodeBase64(packet.tag, 'relay auth tag', 16))
  return Buffer.concat([decipher.update(decodeBase64(packet.ciphertext, 'relay ciphertext', 4 * 1024 * 1024)), decipher.final()])
}

export function assertEncryptedRelayPacket(value: unknown): asserts value is EncryptedRelayPacket {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('relay encrypted packet is invalid')
  const packet = value as Partial<EncryptedRelayPacket>
  if (packet.version !== 1 || typeof packet.nonce !== 'string' || typeof packet.iv !== 'string' || typeof packet.tag !== 'string' || typeof packet.ciphertext !== 'string' || packet.aad !== undefined && typeof packet.aad !== 'string') throw new Error('relay encrypted packet is invalid')
  decodeBase64(packet.nonce, 'relay nonce', 32)
  decodeBase64(packet.iv, 'relay iv', 12)
  decodeBase64(packet.tag, 'relay auth tag', 16)
  decodeBase64(packet.ciphertext, 'relay ciphertext', 4 * 1024 * 1024)
  if (packet.aad !== undefined) decodeBase64(packet.aad, 'relay aad', 4 * 1024)
}

export function assertEncryptedRelayFrame(value: unknown): asserts value is EncryptedRelayFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('relay encrypted frame is invalid')
  const frame = value as Partial<EncryptedRelayFrame>
  if (typeof frame.sessionId !== 'string' || !isBoundedIdentifier(frame.sessionId) || (frame.direction !== 'client_to_server' && frame.direction !== 'server_to_client') || !Number.isSafeInteger(frame.frameSeq) || (frame.frameSeq ?? 0) < 1) throw new Error('relay encrypted frame metadata is invalid')
  assertEncryptedRelayPacket(value)
}

function frameAad(sessionId: string, direction: EncryptedRelayFrame['direction'], frameSeq: number): Uint8Array {
  return Buffer.from(JSON.stringify({ version: 1, sessionId, direction, frameSeq }))
}

/** Compatibility helpers used by the desktop and relay contract tests. */
export function encryptRelayFrame(privateKey: KeyObject, peerPublicKey: string, sessionId: string, direction: EncryptedRelayFrame['direction'], frameSeq: number, plaintext: Uint8Array): EncryptedRelayFrame {
  if (!isBoundedIdentifier(sessionId) || !Number.isSafeInteger(frameSeq) || frameSeq < 1) throw new Error('relay frame metadata is invalid')
  const packet = encryptRelayPayload(privateKey, peerPublicKey, plaintext, frameAad(sessionId, direction, frameSeq))
  return { ...packet, sessionId, direction, frameSeq }
}

export function decryptRelayFrame(privateKey: KeyObject, peerPublicKey: string, frame: EncryptedRelayFrame, guard: RelayReplayGuard): Uint8Array {
  assertEncryptedRelayFrame(frame)
  const expectedAad = frameAad(frame.sessionId, frame.direction, frame.frameSeq)
  if (frame.aad === undefined || !Buffer.from(frame.aad, 'base64').equals(expectedAad)) throw new Error('relay frame metadata authentication failed')
  // Authenticate the ciphertext before advancing the replay window. An
  // unauthenticated packet must not be able to consume a valid sequence and
  // create a denial-of-service gap for the peer.
  const plaintext = decryptRelayPayload(privateKey, peerPublicKey, frame)
  guard.accept(frame.sessionId, frame.direction, frame.frameSeq)
  return plaintext
}

export class RelayReplayGuard {
  private readonly accepted: Map<string, number>
  constructor(initial?: ReadonlyMap<string, number>) { this.accepted = new Map(initial) }
  accept(sessionId: string, direction: EncryptedRelayFrame['direction'], frameSeq: number): void {
    if (!Number.isSafeInteger(frameSeq) || frameSeq < 1) throw new Error('relay frame sequence is invalid')
    const key = `${sessionId}:${direction}`
    const previous = this.accepted.get(key) ?? 0
    if (frameSeq <= previous) throw new Error('relay frame replay detected')
    this.accepted.set(key, frameSeq)
  }
  snapshot(): Map<string, number> { return new Map(this.accepted) }
}

export function createRelaySession(): { sessionId: string; keyPair: RelayKeyPair; guard: RelayReplayGuard } {
  return { sessionId: randomUUID(), keyPair: createRelayKeyPair(), guard: new RelayReplayGuard() }
}

interface RelayPeer {
  sink: (frame: Uint8Array) => void
  role?: RelayPeerRole
  deviceId?: string
  identityPublicKey?: string
}

export class RelayRouter {
  private readonly sessions = new Map<string, Map<string, RelayPeer>>()
  constructor(private readonly trustedIdentityPublicKey?: string) {}

  register(sessionId: string, connectionId: string, sink: (frame: Uint8Array) => void): () => void {
    const peers = this.sessions.get(sessionId) ?? new Map<string, RelayPeer>()
    peers.set(connectionId, { sink }); this.sessions.set(sessionId, peers)
    return () => this.unregister(sessionId, connectionId)
  }

  registerAuthenticated(sessionId: string, connectionId: string, handshake: RelayHandshake, sink: (frame: Uint8Array) => void, expected?: RelayHandshakeExpectations): () => void {
    const fallback = this.trustedIdentityPublicKey === undefined ? {} : { expectedIdentityPublicKey: this.trustedIdentityPublicKey }
    verifyRelayHandshake(handshake, { ...fallback, ...expected })
    if (handshake.sessionId !== sessionId) throw new Error('relay handshake session mismatch')
    const peers = this.sessions.get(sessionId) ?? new Map<string, RelayPeer>()
    if ([...peers.values()].some(peer => peer.role === handshake.role)) throw new Error('relay role is already connected for this session')
    peers.set(connectionId, { sink, role: handshake.role, deviceId: handshake.deviceId, identityPublicKey: handshake.identityPublicKey }); this.sessions.set(sessionId, peers)
    return () => this.unregister(sessionId, connectionId)
  }

  forward(sessionId: string, senderId: string, frame: Uint8Array): number {
    const peers = this.sessions.get(sessionId); if (peers === undefined) return 0
    let delivered = 0
    for (const [connectionId, peer] of peers) { if (connectionId === senderId) continue; peer.sink(frame); delivered += 1 }
    return delivered
  }

  forwardAuthenticated(sessionId: string, senderId: string, frame: EncryptedRelayFrame, encoded: Uint8Array = Buffer.from(JSON.stringify(frame))): number {
    assertEncryptedRelayFrame(frame)
    const peers = this.sessions.get(sessionId)
    const sender = peers?.get(senderId)
    if (peers === undefined || sender === undefined || sender.role === undefined) throw new Error('relay connection is not authenticated')
    const expectedDirection = sender.role === 'client' ? 'client_to_server' : 'server_to_client'
    if (frame.direction !== expectedDirection) throw new Error('relay frame direction is not authorized')
    // This router is intentionally blind: it cannot authenticate the AEAD
    // ciphertext, so advancing a replay window here would let a forged packet
    // consume the sequence number of the real packet. The receiving endpoint
    // must call decryptRelayFrame(), which authenticates before advancing its
    // RelayReplayGuard.
    let delivered = 0
    for (const [connectionId, peer] of peers) { if (connectionId === senderId) continue; peer.sink(encoded); delivered += 1 }
    return delivered
  }

  private unregister(sessionId: string, connectionId: string): void {
    const peers = this.sessions.get(sessionId); if (peers === undefined) return
    peers.delete(connectionId)
    if (peers.size === 0) this.sessions.delete(sessionId)
  }
}

function isBoundedIdentifier(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) }

function decodeBase64(value: string, label: string, maxBytes: number): Buffer {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label} is invalid`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength > maxBytes || decoded.toString('base64') !== value) throw new Error(`${label} is invalid`)
  return decoded
}
