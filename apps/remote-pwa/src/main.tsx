import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteControlClient } from '@dshpilot/remote-client'
import type { ControlEvent, ServerInfo } from '@dshpilot/control-contracts'

const saved = (key: string): string => key === 'dshpilot.endpoint' ? localStorage.getItem(key) ?? '' : sessionStorage.getItem(key) ?? ''
const persist = (key: string, value: string): void => { (key === 'dshpilot.endpoint' ? localStorage : sessionStorage).setItem(key, value) }

function App() {
  const [endpoint, setEndpoint] = useState(saved('dshpilot.endpoint') || 'http://127.0.0.1:6767')
  const [token, setToken] = useState(saved('dshpilot.token'))
  const [refreshToken, setRefreshToken] = useState(saved('dshpilot.refresh'))
  const [deviceId, setDeviceId] = useState(saved('dshpilot.device'))
  const [pairCode, setPairCode] = useState('')
  const [pairName, setPairName] = useState('Remote PWA')
  const [server, setServer] = useState<ServerInfo | undefined>()
  const [events, setEvents] = useState<ControlEvent[]>([])
  const [tasks, setTasks] = useState<Array<{ taskId: string; status: string; title?: string }>>([])
  const [artifacts, setArtifacts] = useState<Array<{ artifactId: string; name: string; bytes: number }>>([])
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | undefined>()
  const streamAbort = useRef<AbortController | undefined>(undefined)
  const client = useMemo(() => new RemoteControlClient({ baseUrl: endpoint, token: token || undefined, refreshToken: refreshToken || undefined, deviceId: deviceId || undefined }), [endpoint, token, refreshToken, deviceId])

  const connectClient = (activeClient: RemoteControlClient): void => {
    streamAbort.current?.abort()
    const controller = new AbortController(); streamAbort.current = controller
    void activeClient.serverInfo().then(setServer).then(async () => { const [page, nextTasks, nextArtifacts] = await Promise.all([activeClient.events(0), activeClient.tasks(), activeClient.artifacts<{ artifactId: string; name: string; bytes: number }>()]); setEvents(page.events); setTasks(nextTasks); setArtifacts(nextArtifacts); return activeClient.streamEvents({ after: page.latestSeq, generation: page.generation, signal: controller.signal, onEvent: event => { setEvents(current => [...current.slice(-99), event]); if (event.type === 'task.updated') void activeClient.tasks().then(setTasks) } }) }).catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)) })
  }
  const connect = (): void => { persist('dshpilot.endpoint', endpoint); persist('dshpilot.token', token); persist('dshpilot.refresh', refreshToken); persist('dshpilot.device', deviceId); connectClient(client) }
  const sendPrompt = (): void => { if (!prompt.trim()) return; void client.control({ kind: 'prompt_admission', requestId: crypto.randomUUID(), input: prompt }).then(() => setPrompt('')).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const createPairingOffer = (): void => { void client.pairingOffer().then(offer => setPairCode(offer.code)).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const completePairing = (): void => { void client.pair(pairCode, pairName).then(result => { setToken(result.token); setRefreshToken(result.refreshToken); setDeviceId(result.device.deviceId); persist('dshpilot.token', result.token); persist('dshpilot.refresh', result.refreshToken); persist('dshpilot.device', result.device.deviceId); connectClient(new RemoteControlClient({ baseUrl: endpoint, token: result.token, refreshToken: result.refreshToken, deviceId: result.device.deviceId })) }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  useEffect(() => { if (token) connect(); return () => streamAbort.current?.abort() }, [])
  return <main style={{ maxWidth: 860, margin: '0 auto', padding: 24, fontFamily: 'system-ui' }}>
    <h1>DSHPilot Remote</h1><p>Self-hosted, restricted control plane. The PWA never receives the Harness process or OS credentials.</p>
    <section style={{ display: 'grid', gap: 8 }}><input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://host:port" /><input value={token} onChange={event => setToken(event.target.value)} placeholder="access token" type="password" /><input value={deviceId} onChange={event => setDeviceId(event.target.value)} placeholder="device id for refresh" /><input value={refreshToken} onChange={event => setRefreshToken(event.target.value)} placeholder="refresh token" type="password" /><button type="button" onClick={connect}>Connect</button></section>
    <section style={{ display: 'grid', gap: 8 }}><h2>Pair a device</h2><input value={pairName} onChange={event => setPairName(event.target.value)} placeholder="device name" /><button type="button" onClick={createPairingOffer}>Create local pairing offer</button><input value={pairCode} onChange={event => setPairCode(event.target.value)} placeholder="one-time pairing code" /><button type="button" onClick={completePairing}>Complete pairing</button></section>
    {server !== undefined && <section><h2>{server.name}</h2><p>Server {server.serverId} · protocol v{server.protocolVersion} · {server.remoteEnabled ? 'remote enabled' : 'loopback only'}</p></section>}
    <section><h2>Prompt admission</h2><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} style={{ width: '100%' }} placeholder="This is admitted as a restricted request; execution remains Harness-owned." /><button type="button" onClick={sendPrompt}>Send</button></section>
    <section><h2>Task Center projection ({tasks.length})</h2>{tasks.map(task => <div key={task.taskId}>{task.taskId} · {task.status}{task.title === undefined ? '' : ` · ${task.title}`}</div>)}</section>
    <section><h2>Artifacts ({artifacts.length})</h2>{artifacts.map(artifact => <div key={artifact.artifactId}>{artifact.name} · {artifact.bytes} bytes · read-only</div>)}</section>
    <section><h2>Durable events</h2>{events.slice().reverse().map(event => <div key={event.eventId}><code>{event.seq}</code> {event.type} <small>{event.at}</small></div>)}</section>
    {error !== undefined && <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</p>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
