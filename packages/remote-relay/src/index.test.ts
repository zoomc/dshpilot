import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { RemoteRelayServer, relayHello, relayWebSocketUrl } from './index.js'

describe('self-hosted blind relay', () => {
  it('fails closed without a token and refuses public plaintext mode', () => {
    expect(() => new RemoteRelayServer()).toThrow(/token/u)
    expect(() => new RemoteRelayServer({ token: 'abc/defghijklmnop' })).toThrow(/base64url/u)
    expect(() => new RemoteRelayServer({ host: '0.0.0.0', token: '0123456789abcdef' })).toThrow(/TLS/u)
  })

  it('authenticates a channel and forwards opaque frames between desktop and client', async () => {
    const relay = new RemoteRelayServer({ token: '0123456789abcdef' }); const address = await relay.start()
    const base = `ws://${address.host}:${address.port}`
    const desktop = new WebSocket(relayWebSocketUrl({ url: base, channelId: 'test', role: 'desktop', token: '0123456789abcdef' }), ['dshpilot-relay-v1.0123456789abcdef'])
    const client = new WebSocket(relayWebSocketUrl({ url: base, channelId: 'test', role: 'client', token: '0123456789abcdef' }), ['dshpilot-relay-v1.0123456789abcdef'])
    const opened = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`relay socket did not open: ${socket.readyState}`)), 1_000); socket.once('open', () => { clearTimeout(timer); resolve() }); socket.once('error', error => { clearTimeout(timer); reject(error) }) })
    await Promise.all([opened(desktop), opened(client)])
    desktop.send(relayHello({ url: base, channelId: 'test', role: 'desktop' })); client.send(relayHello({ url: base, channelId: 'test', role: 'client' }))
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    const forwarded = new Promise<Buffer>(resolve => client.once('message', value => resolve(Buffer.from(value as Buffer))))
    const payload = Buffer.from(JSON.stringify({ version: 1, ciphertext: 'opaque' })); desktop.send(payload)
    await expect(forwarded).resolves.toEqual(payload)
    desktop.close(); client.close(); await relay.stop()
  })
})
