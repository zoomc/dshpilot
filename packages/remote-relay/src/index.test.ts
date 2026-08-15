import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { RemoteRelayServer, relayAuthenticate, relayHello, relayWebSocketUrl } from './index.js'

const TOKEN = '0123456789abcdef'
const highEntropyChannel = (): string => randomBytes(24).toString('base64url')

interface RelayPeer { socket: WebSocket; ready: Promise<void> }
function openRelayPeer(base: string, channelId: string, role: 'desktop' | 'client'): RelayPeer {
  const socket = new WebSocket(relayWebSocketUrl({ url: base, channelId, role, token: TOKEN }), [`dshpilot-relay-v1.${TOKEN}`])
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay peer handshake timed out')), 2_000)
    socket.once('open', () => socket.send(relayHello({ url: base, channelId, role, token: TOKEN })))
    socket.on('message', data => {
      const value = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { type?: string; nonce?: string }
      if (value.type === 'ready') { if (typeof value.nonce !== 'string') { clearTimeout(timer); reject(new Error('relay ready missing nonce')); return }; socket.send(relayAuthenticate({ url: base, channelId, role, token: TOKEN }, value.nonce)) }
      else if (value.type === 'authenticated') { clearTimeout(timer); resolve() }
    })
    socket.once('error', reject)
  })
  return { socket, ready }
}

describe('self-hosted blind relay', () => {
  it('fails closed without a token and refuses public plaintext mode', () => {
    expect(() => new RemoteRelayServer()).toThrow(/token/u)
    expect(() => new RemoteRelayServer({ token: 'abc/defghijklmnop' })).toThrow(/base64url/u)
    expect(() => new RemoteRelayServer({ host: '0.0.0.0', token: '0123456789abcdef' })).toThrow(/TLS/u)
  })

  it('requires a high-entropy channel id (unguessable capability)', async () => {
    const relay = new RemoteRelayServer({ token: TOKEN }); const address = await relay.start(); const base = `ws://${address.host}:${address.port}`
    const socket = new WebSocket(relayWebSocketUrl({ url: base, channelId: 'guessable', role: 'desktop', token: TOKEN }), [`dshpilot-relay-v1.${TOKEN}`])
    const closed = new Promise<number>(resolve => { socket.once('close', code => resolve(code)); socket.once('error', () => resolve(1006)) })
    expect(await closed).not.toBe(1000)
    await relay.stop()
  })

  it('authenticates a channel and forwards opaque frames between desktop and client', async () => {
    const relay = new RemoteRelayServer({ token: TOKEN }); const address = await relay.start(); const base = `ws://${address.host}:${address.port}`
    const channelId = highEntropyChannel()
    const desktop = openRelayPeer(base, channelId, 'desktop'); const client = openRelayPeer(base, channelId, 'client')
    await Promise.all([desktop.ready, client.ready])
    const forwarded = new Promise<Buffer>(resolve => client.socket.once('message', value => resolve(Buffer.from(value as Buffer))))
    const payload = Buffer.from(JSON.stringify({ version: 1, ciphertext: 'opaque' })); desktop.socket.send(payload)
    await expect(forwarded).resolves.toEqual(payload)
    desktop.socket.close(); client.socket.close(); await relay.stop()
  })

  it('rejects a peer that never authenticates with the channel HMAC', async () => {
    const relay = new RemoteRelayServer({ token: TOKEN, handshakeTimeoutMs: 500 }); const address = await relay.start(); const base = `ws://${address.host}:${address.port}`
    const channelId = highEntropyChannel()
    const socket = new WebSocket(relayWebSocketUrl({ url: base, channelId, role: 'desktop', token: TOKEN }), [`dshpilot-relay-v1.${TOKEN}`])
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    await new Promise<void>(resolve => socket.once('open', () => { socket.send(relayHello({ url: base, channelId, role: 'desktop', token: TOKEN })); resolve() }))
    expect(await closed).toBe(1008)
    await relay.stop()
  })

  it('rejects a forged HMAC so a token holder cannot impersonate a channel role', async () => {
    const relay = new RemoteRelayServer({ token: TOKEN }); const address = await relay.start(); const base = `ws://${address.host}:${address.port}`
    const channelId = highEntropyChannel()
    const socket = new WebSocket(relayWebSocketUrl({ url: base, channelId, role: 'desktop', token: TOKEN }), [`dshpilot-relay-v1.${TOKEN}`])
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    await new Promise<void>(resolve => socket.once('open', () => {
      socket.send(relayHello({ url: base, channelId, role: 'desktop', token: TOKEN }))
      socket.on('message', data => { const value = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { type?: string; nonce?: string }; if (value.type === 'ready' && typeof value.nonce === 'string') socket.send(JSON.stringify({ type: 'authenticate', hmac: 'forged' })) })
      resolve()
    }))
    expect(await closed).toBe(1008)
    await relay.stop()
  })

  it('prevents a second peer from claiming an already-connected role (anti-preemption)', async () => {
    const relay = new RemoteRelayServer({ token: TOKEN }); const address = await relay.start(); const base = `ws://${address.host}:${address.port}`
    const channelId = highEntropyChannel()
    const first = openRelayPeer(base, channelId, 'desktop'); await first.ready
    const second = openRelayPeer(base, channelId, 'desktop')
    const closed = new Promise<number>(resolve => second.socket.once('close', code => resolve(code)))
    expect(await closed).toBe(1008)
    first.socket.close(); await relay.stop()
  })
})
