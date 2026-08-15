import { mkdtemp } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { ControlPlaneServer, DurableEventStore, RelayReplayGuard, createRelayIdentity, createRelayKeyPair, createRelaySession, decryptRelayFrame, decryptRelayPayload, encryptRelayFrame, encryptRelayPayload, RelayRouter, signPairingProof, signRelayHandshake, verifyRelayHandshake } from './index.js'

describe('control plane', () => {
  it('serves loopback health, pairing, event replay, and restricted prompt admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-control-'))
    let selectedQuestion: unknown
    let admissions = 0
    const server = new ControlPlaneServer({
      version: '0.1.0', eventsPath: join(root, 'events.jsonl'), devicesPath: join(root, 'devices.json'),
      remoteEnabled: true,
      allowLocalPairingOffer: true,
      allowLocalAdminPairing: true,
      adapter: { admitPrompt: async request => { admissions += 1; await new Promise(resolveDelay => setTimeout(resolveDelay, 10)); return { taskId: `task-${request.requestId}-${request.mode ?? 'queue'}` } }, questionReply: async (rpcId, sessionId, answers) => { selectedQuestion = { rpcId, sessionId, answers } } },
    })
    const address = await server.start()
    const base = `http://${address.host}:${address.port}`
    expect((await fetch(`${base}/health`)).status).toBe(200)
    const offerResponse = await fetch(`${base}/v1/pairing/offer`, { method: 'POST' })
    const offer = (await offerResponse.json() as { value: { code: string } }).value
    const pairResponse = await fetch(`${base}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'test browser', scopes: ['read', 'control', 'admin'] }) })
    const paired = (await pairResponse.json() as { value: { token: string; device: { deviceId: string } } }).value
    expect(paired.device.deviceId).toBeTruthy()
    const control = await fetch(`${base}/v1/control`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prompt_admission', requestId: 'request-1', input: 'hello' }) })
    expect(await control.json()).toMatchObject({ ok: true, value: { taskId: 'task-request-1-queue' } })
    const duplicate = (): Promise<Response> => fetch(`${base}/v1/control`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prompt_admission', requestId: 'request-concurrent', input: 'once' }) })
    const duplicateResponses = await Promise.all([duplicate(), duplicate()])
    const duplicateValues = await Promise.all(duplicateResponses.map(response => response.json())) as Array<{ ok: boolean; value?: { taskId?: string; deduplicated?: boolean } }>
    expect(duplicateValues).toHaveLength(2)
    expect(duplicateValues.every(value => value.ok && value.value?.taskId === 'task-request-concurrent-queue')).toBe(true)
    expect(duplicateValues.filter(value => value.value?.deduplicated === true)).toHaveLength(1)
    expect(admissions).toBe(2)
    const steer = await fetch(`${base}/v1/control`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prompt_admission', requestId: 'request-2', sessionId: 'session-1', mode: 'steer', input: 'steer this turn' }) })
    expect(await steer.json()).toMatchObject({ ok: true, value: { taskId: 'task-request-2-steer' } })
    const question = await fetch(`${base}/v1/control`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'question_reply', requestId: 'question-request-1', rpcId: 'question-rpc-1', sessionId: 'session-1', answers: [{ id: 'choice', selected: ['yes'] }] }) })
    expect(await question.json()).toMatchObject({ ok: true, value: { resolved: true } }); expect(selectedQuestion).toMatchObject({ rpcId: 'question-rpc-1', sessionId: 'session-1' })
    const events = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${paired.token}` } })
    const page = (await events.json() as { value: { events: Array<{ type: string }>; generation: string; resetRequired: boolean } }).value
    expect(page.events.map(event => event.type)).toContain('prompt.accepted')
    expect(page.generation).toBeTruthy(); expect(page.resetRequired).toBe(false)
    const rotated = await fetch(`${base}/v1/devices/${paired.device.deviceId}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}` } })
    const nextToken = (await rotated.json() as { value: { token: string } }).value.token
    expect((await fetch(`${base}/v1/server`, { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(401)
    expect((await fetch(`${base}/v1/server`, { headers: { authorization: `Bearer ${nextToken}` } })).status).toBe(200)
    await server.stop()
  })

  it('requires explicit remote mode for non-loopback binding', () => {
    expect(() => new ControlPlaneServer({ version: '0.1.0', host: '0.0.0.0' })).toThrow('remote mode')
  })

  it('fails cleanly when the control port is already occupied', async () => {
    const first = new ControlPlaneServer({ version: '0.1.0', remoteEnabled: true }); const address = await first.start()
    const second = new ControlPlaneServer({ version: '0.1.0', remoteEnabled: true, host: address.host, port: address.port })
    await expect(second.start()).rejects.toThrow()
    await first.stop()
  })

  it('rejects hostile Host and Origin headers before serving the control plane', async () => {
    const server = new ControlPlaneServer({ version: '0.1.0', remoteEnabled: true })
    const address = await server.start(); const base = `http://${address.host}:${address.port}`
    const hostileHost = await new Promise<number>((resolveStatus, reject) => { const request = httpRequest({ hostname: address.host, port: address.port, path: '/health', headers: { host: `evil.example:${address.port}` } }, response => { response.resume(); response.once('end', () => resolveStatus(response.statusCode ?? 0)) }); request.once('error', reject); request.end() })
    expect(hostileHost).toBe(400)
    expect((await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } })).status).toBe(400)
    expect((await fetch(`${base}/health`, { headers: { origin: base } })).status).toBe(200)
    await server.stop()
  })

  it('does not grant admin through local HTTP pairing by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-pairing-'))
    const server = new ControlPlaneServer({ version: '0.1.0', devicesPath: join(root, 'devices.json'), remoteEnabled: true })
    const address = await server.start()
    const offer = server.devices.createOffer()
    const response = await fetch(`http://${address.host}:${address.port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'restricted', scopes: ['read', 'control', 'admin'] }) })
    const paired = (await response.json() as { value: { token: string } }).value
    expect((await fetch(`http://${address.host}:${address.port}/v1/devices`, { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(401)
    await server.stop()
  })

  it('applies resource authorization to projected reads and receives the control request', async () => {
    const operations: string[] = []
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-resource-auth-'))
    const server = new ControlPlaneServer({
      version: '0.1.0', devicesPath: join(root, 'devices.json'), remoteEnabled: true, allowLocalPairingOffer: true,
      authorization: context => { operations.push(context.operation); if (context.operation === 'artifact_read') return false; return true },
      adapter: { tasks: async () => [], artifacts: async () => [], artifactRead: async () => new Uint8Array([1]) },
    })
    const address = await server.start(); const base = `http://${address.host}:${address.port}`; const offer = server.devices.createOffer()
    const paired = (await (await fetch(`${base}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'resource auth' }) })).json() as { value: { token: string } }).value
    const headers = { authorization: `Bearer ${paired.token}` }
    expect((await fetch(`${base}/v1/tasks`, { headers })).status).toBe(200)
    expect((await fetch(`${base}/v1/artifacts/sha256:${'0'.repeat(64)}`, { headers })).status).toBe(401)
    const control = await fetch(`${base}/v1/control`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'session_list' }) })
    expect(control.status).toBe(200)
    expect(operations).toEqual(expect.arrayContaining(['task_list', 'artifact_read', 'session_list']))
    await server.stop()
  })

  it('exposes artifact open/reveal actions and provider-backed resource reads', async () => {
    const server = new ControlPlaneServer({
      version: '0.1.0', remoteEnabled: true,
      adapter: {
        artifacts: async () => [{ artifactId: 'sha256:' + '1'.repeat(64), name: 'file.txt', bytes: 1 }],
        artifactRead: async () => new Uint8Array([1]),
        artifactOpen: async () => ({ opened: true }),
        artifactReveal: async () => ({ opened: true }),
        resources: async () => [{ resourceId: 'resource-1', kind: 'file', label: 'File', locator: '/tmp/file' }],
        resourceResolve: async (resourceId, operation, input) => ({ resourceId, operation, input }),
      },
    })
    const address = await server.start(); const base = `http://${address.host}:${address.port}`; const offer = server.devices.createOffer()
    const paired = (await (await fetch(`${base}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'artifact viewer' }) })).json() as { value: { token: string } }).value
    const headers = { authorization: `Bearer ${paired.token}` }
    const open = await fetch(`${base}/v1/artifacts/sha256:${'1'.repeat(64)}/open`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })
    expect(open.status).toBe(200); expect(await open.json()).toMatchObject({ ok: true, value: { opened: true } })
    const reveal = await fetch(`${base}/v1/artifacts/sha256:${'1'.repeat(64)}/reveal`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })
    expect(reveal.status).toBe(200); expect(await reveal.json()).toMatchObject({ ok: true, value: { opened: true } })
    const resource = await fetch(`${base}/v1/resources/resource-1?operation=read&offset=4`, { headers })
    expect(resource.status).toBe(200); expect(await resource.json()).toMatchObject({ ok: true, value: { resourceId: 'resource-1', operation: 'read', input: { offset: '4' } } })
    await server.stop()
  })

  it('exposes an authenticated opaque relay WebSocket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-relay-'))
    const server = new ControlPlaneServer({ version: '0.1.0', devicesPath: join(root, 'devices.json'), remoteEnabled: true, relayEnabled: true })
    const address = await server.start()
    const offer = server.devices.createOffer(); const identity = createRelayIdentity()
    const pairResponse = await fetch(`http://${address.host}:${address.port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'relay client', offerId: offer.offerId, serverId: offer.serverId, serverPublicKey: offer.publicKey, identityPublicKey: identity.publicKey, pairingProof: signPairingProof(identity, { serverId: offer.serverId, serverPublicKey: offer.publicKey, offerId: offer.offerId, nonce: offer.nonce }) }) })
    const paired = (await pairResponse.json() as { value: { token: string; device: { deviceId: string } } }).value
    const session = createRelaySession(); const socket = new WebSocket(`ws://${address.host}:${address.port}/v1/relay`, { headers: { authorization: `Bearer ${paired.token}` } })
    const ready = new Promise<void>((resolveReady, rejectReady) => { socket.once('error', rejectReady); socket.on('message', data => { if (JSON.parse(data.toString()).type === 'ready') resolveReady() }) })
    await new Promise<void>((resolveOpen, rejectOpen) => { socket.once('open', () => resolveOpen()); socket.once('error', rejectOpen) })
    socket.send(JSON.stringify({ type: 'handshake', handshake: signRelayHandshake(identity, { sessionId: session.sessionId, x25519PublicKey: session.keyPair.publicKey, deviceId: paired.device.deviceId, serverId: server.devices.serverId(), serverPublicKey: server.devices.publicKey(), role: 'client' }) }))
    await ready
    socket.close(); await new Promise<void>(resolveClose => socket.once('close', () => resolveClose()))
    await server.stop()
  })

  it('rejects relay payloads that are not encrypted frame envelopes', async () => {
    const server = new ControlPlaneServer({ version: '0.1.0', remoteEnabled: true, relayEnabled: true })
    const address = await server.start(); const offer = server.devices.createOffer(); const identity = createRelayIdentity()
    const pairResponse = await fetch(`http://${address.host}:${address.port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'relay validation', offerId: offer.offerId, serverId: offer.serverId, serverPublicKey: offer.publicKey, identityPublicKey: identity.publicKey, pairingProof: signPairingProof(identity, { serverId: offer.serverId, serverPublicKey: offer.publicKey, offerId: offer.offerId, nonce: offer.nonce }) }) })
    const paired = (await pairResponse.json() as { value: { token: string; device: { deviceId: string } } }).value
    const session = createRelaySession(); const socket = new WebSocket(`ws://${address.host}:${address.port}/v1/relay`, { headers: { authorization: `Bearer ${paired.token}` } })
    await new Promise<void>((resolveOpen, rejectOpen) => { socket.once('open', () => resolveOpen()); socket.once('error', rejectOpen) })
    socket.send(JSON.stringify({ type: 'handshake', handshake: signRelayHandshake(identity, { sessionId: session.sessionId, x25519PublicKey: session.keyPair.publicKey, deviceId: paired.device.deviceId, serverId: server.devices.serverId(), serverPublicKey: server.devices.publicKey(), role: 'client' }) }))
    await new Promise<void>((resolveReady, rejectReady) => { socket.once('message', data => JSON.parse(data.toString()).type === 'ready' ? resolveReady() : undefined); socket.once('error', rejectReady) })
    socket.send(JSON.stringify({ sessionId: session.sessionId, direction: 'client_to_server', frameSeq: 1, plaintext: 'must not be relayed' }))
    await new Promise<void>((resolveClose, rejectClose) => { socket.once('close', () => resolveClose()); socket.once('error', rejectClose) })
    await server.stop()
  })
})

describe('relay payloads', () => {
  it('encrypts and decrypts with mutually derived X25519 keys', () => {
    const left = createRelayKeyPair(); const right = createRelayKeyPair()
    const packet = encryptRelayPayload(left.privateKey, right.publicKey, new TextEncoder().encode('private event'), new TextEncoder().encode('event-1'))
    const plaintext = decryptRelayPayload(right.privateKey, left.publicKey, packet)
    expect(new TextDecoder().decode(plaintext)).toBe('private event')
    const corrupted = Buffer.from(packet.ciphertext, 'base64'); corrupted[0] = (corrupted[0] ?? 0) ^ 1
    expect(() => decryptRelayPayload(right.privateKey, left.publicKey, { ...packet, ciphertext: corrupted.toString('base64') })).toThrow()
  })

  it('binds encrypted frames to direction and rejects replay', () => {
    const left = createRelayKeyPair(); const right = createRelayKeyPair(); const guard = new RelayReplayGuard()
    const frame = encryptRelayFrame(left.privateKey, right.publicKey, 'session-1', 'client_to_server', 1, new TextEncoder().encode('one'))
    expect(new TextDecoder().decode(decryptRelayFrame(right.privateKey, left.publicKey, frame, guard))).toBe('one')
    expect(() => decryptRelayFrame(right.privateKey, left.publicKey, frame, guard)).toThrow('replay')
    expect(() => decryptRelayFrame(right.privateKey, left.publicKey, { ...frame, frameSeq: 2, direction: 'server_to_client' }, new RelayReplayGuard())).toThrow()
  })

  it('does not consume a replay sequence when ciphertext authentication fails', () => {
    const left = createRelayKeyPair(); const right = createRelayKeyPair(); const guard = new RelayReplayGuard()
    const frame = encryptRelayFrame(left.privateKey, right.publicKey, 'sequence-safety', 'client_to_server', 1, new TextEncoder().encode('payload'))
    const corrupted = Buffer.from(frame.ciphertext, 'base64'); corrupted[0] = (corrupted[0] ?? 0) ^ 1
    expect(() => decryptRelayFrame(right.privateKey, left.publicKey, { ...frame, ciphertext: corrupted.toString('base64') }, guard)).toThrow()
    expect(new TextDecoder().decode(decryptRelayFrame(right.privateKey, left.publicKey, frame, guard))).toBe('payload')
  })

  it('binds an ephemeral key to an authenticated identity and routes opaque frames only', () => {
    const identity = createRelayIdentity(); const session = createRelaySession(); const handshake = signRelayHandshake(identity, session.sessionId, session.keyPair.publicKey)
    expect(() => verifyRelayHandshake(handshake)).not.toThrow()
    expect(() => verifyRelayHandshake({ ...handshake, sessionId: 'attacker-session' })).toThrow('identity')
    const router = new RelayRouter(); const received: Uint8Array[] = []; const disposeA = router.register(session.sessionId, 'a', () => undefined); const disposeB = router.register(session.sessionId, 'b', frame => received.push(frame))
    expect(router.forward(session.sessionId, 'a', new Uint8Array([1, 2, 3]))).toBe(1); expect(received[0]).toEqual(new Uint8Array([1, 2, 3])); disposeA(); disposeB()
  })

  it('enforces authenticated relay direction and replay windows', () => {
    const session = createRelaySession(); const clientIdentity = createRelayIdentity(); const serverIdentity = createRelayIdentity(); const router = new RelayRouter(); const received: Uint8Array[] = []
    const clientHandshake = signRelayHandshake(clientIdentity, { sessionId: session.sessionId, x25519PublicKey: session.keyPair.publicKey, deviceId: 'device-1', serverId: 'server-1', serverPublicKey: serverIdentity.publicKey, role: 'client' })
    const serverHandshake = signRelayHandshake(serverIdentity, { sessionId: session.sessionId, x25519PublicKey: session.keyPair.publicKey, deviceId: 'device-1', serverId: 'server-1', serverPublicKey: serverIdentity.publicKey, role: 'server' })
    const disposeClient = router.registerAuthenticated(session.sessionId, 'client', clientHandshake, () => undefined)
    const disposeServer = router.registerAuthenticated(session.sessionId, 'server', serverHandshake, frame => received.push(new Uint8Array(frame)), { expectedServerPublicKey: serverIdentity.publicKey })
    const frame = encryptRelayFrame(session.keyPair.privateKey, session.keyPair.publicKey, session.sessionId, 'client_to_server', 1, new TextEncoder().encode('hello'))
    expect(router.forwardAuthenticated(session.sessionId, 'client', frame)).toBe(1)
    expect(received[0]).toEqual(new Uint8Array(Buffer.from(JSON.stringify(frame))))
    expect(router.forwardAuthenticated(session.sessionId, 'client', frame)).toBe(1)
    const wrongDirection = { ...encryptRelayFrame(session.keyPair.privateKey, session.keyPair.publicKey, session.sessionId, 'server_to_client', 2, new TextEncoder().encode('bad')) }
    expect(() => router.forwardAuthenticated(session.sessionId, 'client', wrongDirection)).toThrow('direction')
    disposeClient(); disposeServer()
  })
})

describe('durable remote cursors', () => {
  it('persists generation and sequence across daemon restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-events-')); const file = join(root, 'events.jsonl')
    const first = new DurableEventStore({ filePath: file }); await first.load(); first.append('task.updated', { taskId: 't', status: 'queued', updatedAt: new Date().toISOString() }); await first.flush()
    const second = new DurableEventStore({ filePath: file }); await second.load(); expect(second.generation).toBe(first.generation); expect(second.latestSequence()).toBe(1); expect(second.page(0, 10, first.generation).resetRequired).toBe(false)
  })
})
