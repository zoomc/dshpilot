import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RemoteControlClient, RelayControlClient } from '../packages/remote-client/src/index.js'
import { RemoteRelayServer } from '../packages/remote-relay/src/index.js'
import { ControlPlaneServer, RestrictedRelayTunnel } from '../packages/remote-daemon/src/index.js'

describe('self-hosted relay integration', () => {
  it('completes a restricted desktop outbound relay to PWA control request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-relay-e2e-'))
    const control = new ControlPlaneServer({ version: '0.1.0', name: 'relayed control', remoteEnabled: true, allowLocalPairingOffer: true, devicesPath: join(root, 'devices.json') }); const controlAddress = await control.start(); const offer = control.devices.createOffer()
    const relay = new RemoteRelayServer({ token: '0123456789abcdef' }); const relayAddress = await relay.start()
    const channelId = randomBytes(24).toString('base64url')
    const tunnel = new RestrictedRelayTunnel({ relayUrl: `ws://${relayAddress.host}:${relayAddress.port}`, channelId, token: '0123456789abcdef', encryptionKey: 'fedcba9876543210-encryption', localBaseUrl: `http://${controlAddress.host}:${controlAddress.port}` }); tunnel.start()
    const client = new RelayControlClient({ relayUrl: `ws://${relayAddress.host}:${relayAddress.port}`, channelId, role: 'client', token: '0123456789abcdef', encryptionKey: 'fedcba9876543210-encryption' })
    await expect(client.pair(offer.code, 'relay integration', offer)).resolves.toMatchObject({ device: { name: 'relay integration' } })
    await expect(client.serverInfo()).resolves.toMatchObject({ name: 'relayed control' })
    await expect(client.events(0)).resolves.toMatchObject({ events: expect.any(Array) })
    await expect(client.permissions('session-query')).resolves.toEqual([])
    client.close(); tunnel.stop(); await relay.stop(); await control.stop()
  })
})

describe('RemoteControlClient', () => {
  it('single-flights rotated-token refresh and persists the callback result', async () => {
    let refreshes = 0; let token = 'old-token'; let saved: string | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/token/refresh')) {
        refreshes += 1; await new Promise(resolve => setTimeout(resolve, 10)); token = 'new-token'
        return new Response(JSON.stringify({ ok: true, value: { device: { deviceId: 'device-1' }, token, refreshToken: 'next-refresh' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (new Headers(init?.headers).get('authorization') === 'Bearer old-token') return new Response(JSON.stringify({ ok: false }), { status: 401 })
      return new Response(JSON.stringify({ ok: true, value: { name: 'DSHPilot' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const client = new RemoteControlClient({ baseUrl: 'https://relay.example', token: 'old-token', refreshToken: 'refresh-1', deviceId: 'device-1', fetchImpl, onCredentialsChanged: value => { saved = value.token } })
    const [first, second] = await Promise.all([client.serverInfo(), client.serverInfo()])
    expect(first.name).toBe('DSHPilot'); expect(second.name).toBe('DSHPilot'); expect(refreshes).toBe(1); expect(saved).toBe('new-token')
  })
})
