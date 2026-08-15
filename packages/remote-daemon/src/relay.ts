import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify as verifySignature, type KeyObject } from 'node:crypto'

export interface RelayKeyPair {
  privateKey: KeyObject
  publicKey: string
}

export interface RelayIdentity {
  privateKey: KeyObject
  publicKey: string
}

export interface RelayHandshake {
  version: 1
  sessionId: string
  x25519PublicKey: string
  identityPublicKey: string
  signature: string
}

export function createRelayIdentity(): RelayIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

function identityPublicKey(value: string): KeyObject { return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }) }
function handshakePayload(sessionId: string, x25519PublicKey: string): Buffer { return Buffer.from(`dshpilot-relay-handshake-v1:${sessionId}:${x25519PublicKey}`) }

export function signRelayHandshake(identity: RelayIdentity, sessionId: string, x25519PublicKey: string): RelayHandshake {
  return { version: 1, sessionId, x25519PublicKey, identityPublicKey: identity.publicKey, signature: sign(null, handshakePayload(sessionId, x25519PublicKey), identity.privateKey).toString('base64') }
}

export function verifyRelayHandshake(handshake: RelayHandshake, expectedIdentityPublicKey?: string): void {
  if (handshake.version !== 1 || !handshake.sessionId || !handshake.x25519PublicKey) throw new Error('relay handshake is invalid')
  if (expectedIdentityPublicKey !== undefined && handshake.identityPublicKey !== expectedIdentityPublicKey) throw new Error('relay handshake identity is not trusted')
  if (!verifySignature(null, handshakePayload(handshake.sessionId, handshake.x25519PublicKey), identityPublicKey(handshake.identityPublicKey), Buffer.from(handshake.signature, 'base64'))) throw new Error('relay handshake identity signature mismatch')
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
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
}

function relayKey(privateKey: KeyObject, peerPublicKey: string, nonce: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: publicKey(peerPublicKey) })
  return Buffer.from(hkdfSync('sha256', shared, nonce, Buffer.from('dshpilot-relay-v1'), 32))
}

export function encryptRelayPayload(privateKey: KeyObject, peerPublicKey: string, plaintext: Uint8Array, aad?: Uint8Array): EncryptedRelayPacket {
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
  if (packet.version !== 1) throw new Error('unsupported relay packet version')
  const nonce = Buffer.from(packet.nonce, 'base64')
  const key = relayKey(privateKey, peerPublicKey, nonce)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(packet.iv, 'base64'))
  if (packet.aad !== undefined) decipher.setAAD(Buffer.from(packet.aad, 'base64'))
  decipher.setAuthTag(Buffer.from(packet.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(packet.ciphertext, 'base64')), decipher.final()])
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

export class RelayRouter {
  private readonly sessions = new Map<string, Map<string, (frame: Uint8Array) => void>>()
  constructor(private readonly trustedIdentityPublicKey?: string) {}
  register(sessionId: string, connectionId: string, sink: (frame: Uint8Array) => void): () => void {
    const peers = this.sessions.get(sessionId) ?? new Map<string, (frame: Uint8Array) => void>(); peers.set(connectionId, sink); this.sessions.set(sessionId, peers)
    return () => { peers.delete(connectionId); if (peers.size === 0) this.sessions.delete(sessionId) }
  }
  registerAuthenticated(sessionId: string, connectionId: string, handshake: RelayHandshake, sink: (frame: Uint8Array) => void): () => void {
    verifyRelayHandshake(handshake, this.trustedIdentityPublicKey)
    if (handshake.sessionId !== sessionId) throw new Error('relay handshake session mismatch')
    return this.register(sessionId, connectionId, sink)
  }
  forward(sessionId: string, senderId: string, frame: Uint8Array): number {
    if (frame.byteLength > 4 * 1024 * 1024) throw new Error('relay frame exceeds 4 MiB')
    const peers = this.sessions.get(sessionId); if (peers === undefined) return 0; let delivered = 0
    for (const [connectionId, sink] of peers) { if (connectionId === senderId) continue; sink(frame); delivered += 1 }
    return delivered
  }
}

export function encryptRelayFrame(privateKey: KeyObject, peerPublicKey: string, sessionId: string, direction: EncryptedRelayFrame['direction'], frameSeq: number, plaintext: Uint8Array): EncryptedRelayFrame {
  const aad = new TextEncoder().encode(`${sessionId}:${direction}:${frameSeq}`)
  return { ...encryptRelayPayload(privateKey, peerPublicKey, plaintext, aad), sessionId, direction, frameSeq }
}

export function decryptRelayFrame(privateKey: KeyObject, peerPublicKey: string, frame: EncryptedRelayFrame, guard: RelayReplayGuard): Uint8Array {
  if (!Number.isSafeInteger(frame.frameSeq) || frame.frameSeq < 1) throw new Error('relay frame sequence is invalid')
  const expectedAad = Buffer.from(`${frame.sessionId}:${frame.direction}:${frame.frameSeq}`).toString('base64')
  if (frame.aad !== expectedAad) throw new Error('relay frame metadata authentication failed')
  // Authenticate before advancing the replay window. An attacker must not be
  // able to consume a sequence number with a forged direction or ciphertext.
  const plaintext = decryptRelayPayload(privateKey, peerPublicKey, frame)
  guard.accept(frame.sessionId, frame.direction, frame.frameSeq)
  return plaintext
}
