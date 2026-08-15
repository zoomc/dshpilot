import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RelayControlClient, RemoteControlClient } from '@dshpilot/remote-client'
import type { ControlEvent, EventPage, PairingOffer, PermissionSummary, ServerInfo, SessionSummary } from '@dshpilot/control-contracts'
import { initialSyncState, loadCursor, reduceSync, saveCursor, type SyncState } from './stream-sync.js'
import QRCode from 'qrcode'

const saved = (key: string): string => key === 'dshpilot.endpoint' ? localStorage.getItem(key) ?? '' : sessionStorage.getItem(key) ?? ''
const persist = (key: string, value: string): void => { (key === 'dshpilot.endpoint' ? localStorage : sessionStorage).setItem(key, value) }
function cached<T>(key: string, fallback: T): T { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) as T } catch { return fallback } }
function cache<T>(key: string, value: T): void { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* offline cache is best effort and never blocks remote control */ } }
function parsePairingOffer(value: string): PairingOffer | undefined {
  try {
    const offer = JSON.parse(value) as Partial<PairingOffer>
    if (offer.schemaVersion !== 1 || typeof offer.offerId !== 'string' || typeof offer.serverId !== 'string' || typeof offer.publicKey !== 'string' || typeof offer.code !== 'string' || typeof offer.nonce !== 'string' || typeof offer.expiresAt !== 'string') return undefined
    return offer as PairingOffer
  } catch { return undefined }
}

type PendingQuestion = { rpcId: string; sessionId: string; questions: Array<{ id: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> }
type QuestionDraft = { selected: string[]; custom: string }
type Artifact = { artifactId: string; name: string; bytes: number; mediaType?: string }
type Resource = { resourceId: string; kind: string; label: string; locator: string }
type GitSummary = { branch?: string; status?: string; staged?: string[]; unstaged?: string[]; changedFiles?: string[]; diff?: string; commit?: string }
type ControlClient = RemoteControlClient | RelayControlClient

function App() {
  const [endpoint, setEndpoint] = useState(saved('dshpilot.endpoint') || 'http://127.0.0.1:6767')
  const [relayUrl, setRelayUrl] = useState(localStorage.getItem('dshpilot.relay.url') ?? '')
  const [relayChannel, setRelayChannel] = useState(localStorage.getItem('dshpilot.relay.channel') ?? '')
  const [relayToken, setRelayToken] = useState(sessionStorage.getItem('dshpilot.relay.token') ?? '')
  const [relayKey, setRelayKey] = useState(sessionStorage.getItem('dshpilot.relay.key') ?? '')
  const [token, setToken] = useState(saved('dshpilot.token'))
  const [refreshToken, setRefreshToken] = useState(saved('dshpilot.refresh'))
  const [deviceId, setDeviceId] = useState(saved('dshpilot.device'))
  const [pairCode, setPairCode] = useState('')
  const [pairingOffer, setPairingOffer] = useState<PairingOffer | undefined>()
  const [pairingQr, setPairingQr] = useState<string | undefined>()
  const [pairName, setPairName] = useState('Remote PWA')
  const [server, setServer] = useState<ServerInfo | undefined>()
  const [sync, setSync] = useState<SyncState>(() => ({ ...initialSyncState, cursor: loadCursor() }))
  const [notifications, setNotifications] = useState<Array<{ id: string; title: string; body: string; at: string }>>(() => cached('dshpilot.remote.notifications', []))
  const [events, setEvents] = useState<ControlEvent[]>(() => cached('dshpilot.remote.events', []))
  const [tasks, setTasks] = useState<Array<{ taskId: string; status: string; title?: string }>>(() => cached('dshpilot.remote.tasks', []))
  const [sessions, setSessions] = useState<SessionSummary[]>(() => cached('dshpilot.remote.sessions', []))
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [mode, setMode] = useState<'queue' | 'steer'>('queue')
  const [permissions, setPermissions] = useState<PermissionSummary[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [resources, setResources] = useState<Resource[]>([])
  const [resourceDetails, setResourceDetails] = useState<Record<string, unknown>>({})
  const [lineage, setLineage] = useState<Array<{ sessionId: string; parentSessionId?: string }>>([])
  const [gitSummary, setGitSummary] = useState<GitSummary>()
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({})
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | undefined>()
  const streamAbort = useRef<AbortController | undefined>(undefined)
  const activeClientRef = useRef<ControlClient | undefined>(undefined)
  const persistRemoteCredentials = (value: { device: { deviceId: string }; token: string; refreshToken: string }): void => { setToken(value.token); setRefreshToken(value.refreshToken); setDeviceId(value.device.deviceId); persist('dshpilot.token', value.token); persist('dshpilot.refresh', value.refreshToken); persist('dshpilot.device', value.device.deviceId) }
  const directClient = useMemo(() => new RemoteControlClient({ baseUrl: endpoint, token: token || undefined, refreshToken: refreshToken || undefined, deviceId: deviceId || undefined, onCredentialsChanged: persistRemoteCredentials }), [endpoint, token, refreshToken, deviceId])
  const client = useMemo<ControlClient>(() => relayUrl !== '' && relayChannel !== '' && relayToken !== '' && relayKey !== '' ? new RelayControlClient({ relayUrl, channelId: relayChannel, role: 'client', token: relayToken, encryptionKey: relayKey, accessToken: token || undefined, refreshToken: refreshToken || undefined, deviceId: deviceId || undefined, onCredentialsChanged: persistRemoteCredentials }) : directClient, [relayUrl, relayChannel, relayToken, relayKey, token, refreshToken, deviceId, directClient])

  const connectClient = (activeClient: ControlClient): void => {
    const previousClient = activeClientRef.current
    if (previousClient !== activeClient && previousClient instanceof RelayControlClient) previousClient.close()
    activeClientRef.current = activeClient
    streamAbort.current?.abort()
    const controller = new AbortController(); streamAbort.current = controller
    setSync(current => reduceSync(current, { kind: 'stream-connecting' }))
    void activeClient.serverInfo().then(value => { setServer(value); setSync(current => reduceSync(current, { kind: 'http-up' })); return value }).then(async () => {
      const [page, nextTasks, nextSessions, nextPermissions, nextArtifacts, nextResources] = await Promise.all([
        activeClient.events(0), activeClient.tasks(), activeClient.sessions(), activeClient.permissions(),
        activeClient.artifacts<Artifact>(), activeClient.resources<Resource>(),
      ])
      const nextQuestions = await activeClient.questions<PendingQuestion>()
      setEvents(page.events); setTasks(nextTasks); setSessions(nextSessions); setPermissions(nextPermissions); setArtifacts(nextArtifacts); setResources(nextResources); setQuestions(nextQuestions)
      setSelectedSessionId(current => current || nextSessions[0]?.sessionId || '')
      // Reconcile the durable cursor against the server's current generation: a
      // mismatch or resetRequired flags a reset; a forward jump flags a gap.
      setSync(current => reduceSync(current, { kind: 'snapshot', page }))
      saveCursor({ generation: page.generation, lastSeq: page.latestSeq })
      return activeClient.streamEvents({ after: page.latestSeq, generation: page.generation, signal: controller.signal, onEvent: event => {
        setEvents(current => [...current.slice(-99), event])
        if (event.type === 'notification.created') {
          const notePayload = event.payload as { title?: unknown; body?: unknown }
          const notification = { id: event.eventId, title: String(notePayload.title ?? 'DSHPilot'), body: String(notePayload.body ?? ''), at: event.at }
          setNotifications(current => [notification, ...current].slice(0, 50))
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(notification.title, { body: notification.body })
        }
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && ['notification.created', 'permission.requested', 'task.updated'].includes(event.type) && event.type !== 'notification.created') {
          const payload = event.payload as { title?: unknown; body?: unknown; waitingFor?: unknown }
          if (event.type !== 'task.updated' || payload.waitingFor === 'user-question') new Notification(String(payload.title ?? 'DSHPilot'), { body: String(payload.body ?? (payload.waitingFor === 'user-question' ? 'Harness needs an answer' : 'Remote Harness activity')) })
        }
        // Advance the durable cursor on every contiguous event so a reload /
        // reconnect resumes exactly where we left off (no duplicate replay).
        setSync(current => reduceSync(current, { kind: 'event', event }))
        saveCursor({ generation: event.generation, lastSeq: event.seq })
        if (event.type !== 'task.updated') return
        const payload = event.payload as { waitingFor?: string; rpcId?: string; sessionId?: string; questions?: PendingQuestion['questions'] }
        if (payload.waitingFor === 'user-question' && payload.rpcId !== undefined && payload.sessionId !== undefined && payload.questions !== undefined) setQuestions(current => [...current.filter(item => item.rpcId !== payload.rpcId), { rpcId: payload.rpcId!, sessionId: payload.sessionId!, questions: payload.questions! }])
        if (payload.waitingFor === 'user-question-resolved' && payload.rpcId !== undefined) setQuestions(current => current.filter(item => item.rpcId !== payload.rpcId))
        void activeClient.sessions().then(setSessions); void activeClient.tasks().then(setTasks); void activeClient.permissions().then(setPermissions)
      } })
    }).catch(value => { if (!controller.signal.aborted) { setSync(current => reduceSync(current, { kind: 'stream-error', message: value instanceof Error ? value.message : String(value) })); setError(value instanceof Error ? value.message : String(value)) } })
  }
  const connect = (): void => { persist('dshpilot.endpoint', endpoint); persist('dshpilot.token', token); persist('dshpilot.refresh', refreshToken); persist('dshpilot.device', deviceId); localStorage.setItem('dshpilot.relay.url', relayUrl); localStorage.setItem('dshpilot.relay.channel', relayChannel); if (relayToken) sessionStorage.setItem('dshpilot.relay.token', relayToken); else sessionStorage.removeItem('dshpilot.relay.token'); if (relayKey) sessionStorage.setItem('dshpilot.relay.key', relayKey); else sessionStorage.removeItem('dshpilot.relay.key'); connectClient(client) }
  const sendPrompt = (): void => { if (!prompt.trim()) return; void client.control({ kind: 'prompt_admission', requestId: crypto.randomUUID(), ...(selectedSessionId ? { sessionId: selectedSessionId } : {}), mode, input: prompt }).then(() => setPrompt('')).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const cancelSession = (): void => { if (!selectedSessionId) return; void client.interrupt(selectedSessionId).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const answerPermission = (permissionId: string, decision: 'allow' | 'deny'): void => { void client.permissionReply(permissionId, decision).then(() => setPermissions(current => current.filter(item => item.permissionId !== permissionId))).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const updateQuestionDraft = (rpcId: string, questionId: string, selected: string[], custom: string): void => { setQuestionDrafts(current => ({ ...current, [`${rpcId}:${questionId}`]: { selected, custom } })) }
  const answerQuestion = (pending: PendingQuestion): void => {
    const answers = pending.questions.map(question => { const draft = questionDrafts[`${pending.rpcId}:${question.id}`] ?? { selected: [], custom: '' }; return { id: question.id, selected: draft.selected, ...(draft.custom.trim() === '' ? {} : { custom: draft.custom.trim() }) } })
    void client.control({ kind: 'question_reply', requestId: crypto.randomUUID(), rpcId: pending.rpcId, sessionId: pending.sessionId, answers }).then(() => { setQuestions(current => current.filter(item => item.rpcId !== pending.rpcId)); setQuestionDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${pending.rpcId}:`)))) }).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  const createPairingOffer = (): void => { const pairingClient = relayUrl !== '' && relayChannel !== '' && relayToken !== '' && relayKey !== '' ? client : directClient; void pairingClient.pairingOffer().then(async offer => { setPairingOffer(offer); setPairCode(offer.code); setPairingQr(await QRCode.toDataURL(JSON.stringify(offer), { width: 280, margin: 2 })) }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const completePairing = (): void => {
    const pastedOffer = parsePairingOffer(pairCode.trim()); const offer = pastedOffer ?? pairingOffer; const code = offer?.code ?? pairCode.trim()
    if (code === '') { setError('请输入 pairing code 或完整 pairing offer JSON'); return }
    const pairingClient = relayUrl !== '' && relayChannel !== '' && relayToken !== '' && relayKey !== '' ? client : directClient
    void pairingClient.pair(code, pairName, offer).then(result => { persistRemoteCredentials(result); const nextClient: ControlClient = relayUrl !== '' && relayChannel !== '' && relayToken !== '' && relayKey !== '' ? new RelayControlClient({ relayUrl, channelId: relayChannel, role: 'client', token: relayToken, encryptionKey: relayKey, accessToken: result.token, refreshToken: result.refreshToken, deviceId: result.device.deviceId, onCredentialsChanged: persistRemoteCredentials }) : new RemoteControlClient({ baseUrl: endpoint, token: result.token, refreshToken: result.refreshToken, deviceId: result.device.deviceId, onCredentialsChanged: persistRemoteCredentials }); connectClient(nextClient) }).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  const inspectSession = (sessionId: string): void => { setSelectedSessionId(sessionId); void client.lineage<{ sessionId: string; parentSessionId?: string }>(sessionId).then(setLineage).catch(value => setError(value instanceof Error ? value.message : String(value))); const cwd = sessions.find(session => session.sessionId === sessionId)?.cwd; if (cwd !== undefined) void client.git<GitSummary>(cwd).then(setGitSummary).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const openGitPath = (path: string, reveal: boolean): void => { const cwd = sessions.find(session => session.sessionId === selectedSessionId)?.cwd; if (cwd === undefined) return; void (reveal ? client.gitReveal(cwd, path) : client.gitOpen(cwd, path)).then(value => { if (!value.opened) setError('Desktop could not open this Git path') }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const copyPatch = (): void => { const write = navigator.clipboard?.writeText(gitSummary?.diff ?? ''); if (write !== undefined) void write.catch(value => setError(value instanceof Error ? value.message : String(value))); else setError('Clipboard access is unavailable') }
  const downloadArtifact = (artifactId: string, name: string): void => { void client.artifactRead(artifactId).then(bytes => { const link = document.createElement('a'); const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; link.href = URL.createObjectURL(new Blob([body])); link.download = name; link.click(); URL.revokeObjectURL(link.href) }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const previewArtifact = (artifact: Artifact): void => { void client.artifactRead(artifact.artifactId).then(bytes => { const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; const url = URL.createObjectURL(new Blob([body], { type: artifact.mediaType ?? 'application/octet-stream' })); const opened = window.open(url, '_blank', 'noopener,noreferrer'); if (opened === null) setError('Browser blocked the artifact preview window'); window.setTimeout(() => URL.revokeObjectURL(url), 60_000) }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const openArtifact = (artifactId: string): void => { void client.artifactOpen(artifactId).then(value => { if (!value.opened) setError('Desktop could not open this artifact') }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const revealArtifact = (artifactId: string): void => { void client.artifactReveal(artifactId).then(value => { if (!value.opened) setError('Desktop could not reveal this artifact') }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const inspectResource = (resourceId: string, operation: 'inspect' | 'tree' | 'read' = 'inspect'): void => { void client.resource<Record<string, unknown>>(resourceId, operation).then(value => setResourceDetails(current => ({ ...current, [resourceId]: value }))).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const enableNotifications = (): void => { if (typeof Notification !== 'undefined') void Notification.requestPermission() }
  const connectionLabel = sync.sse === 'live' ? 'connected' : sync.http === 'down' ? 'offline' : sync.sse === 'idle' ? 'offline' : 'connecting'
  useEffect(() => { if (token) connect(); return () => { streamAbort.current?.abort(); if (activeClientRef.current instanceof RelayControlClient) activeClientRef.current.close() } }, [])
  useEffect(() => () => { if (client instanceof RelayControlClient && client !== activeClientRef.current) client.close() }, [client])
  useEffect(() => { cache('dshpilot.remote.events', events.slice(-200)); cache('dshpilot.remote.tasks', tasks); cache('dshpilot.remote.sessions', sessions); cache('dshpilot.remote.notifications', notifications) }, [events, tasks, sessions, notifications])
  useEffect(() => {
    if (!token) return
    const heartbeat = window.setInterval(() => { void client.serverInfo().then(value => { setServer(value); setSync(current => reduceSync(current, { kind: 'http-up' })) }).catch(() => setSync(current => reduceSync(current, { kind: 'http-down' }))) }, 15_000)
    return () => window.clearInterval(heartbeat)
  }, [client, token])

  return <main style={{ maxWidth: 860, margin: '0 auto', padding: 24, fontFamily: 'system-ui' }}>
    <h1>DSHPilot Remote</h1><p>Self-hosted, restricted control plane. The PWA never receives the Harness process or OS credentials. Connection: {connectionLabel} · HTTP {sync.http} · Stream {sync.sse}</p>
    {sync.sse === 'connecting' && <p style={{ color: '#4d83ff' }}>Connecting to event stream…</p>}
    {sync.sse === 'reconnecting' && <p style={{ color: '#4d83ff' }}>Reconnecting to event stream…</p>}
    {sync.sse === 'catching-up' && <p style={{ color: '#4d83ff' }}>Catching up on the latest activity…</p>}
    {sync.sse === 'gap' && <p style={{ color: 'orange', whiteSpace: 'pre-wrap' }}>Event gap detected: {sync.note ?? 'some activity may be missing'}. The projection is best-effort until the next snapshot.</p>}
    {sync.sse === 'reset' && <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>Stream generation changed: {sync.note ?? 'server restarted'}. Reloading the projection.</p>}
    {typeof Notification !== 'undefined' && Notification.permission !== 'granted' && <button type="button" onClick={enableNotifications}>Enable remote notifications</button>}
    <section style={{ display: 'grid', gap: 8 }}><input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://host:port (direct control plane)" /><input value={relayUrl} onChange={event => setRelayUrl(event.target.value)} placeholder="wss://relay.example (optional self-hosted relay)" /><input value={relayChannel} onChange={event => setRelayChannel(event.target.value)} placeholder="relay channel id" /><input value={relayToken} onChange={event => setRelayToken(event.target.value)} placeholder="relay auth token (base64url)" type="password" /><input value={relayKey} onChange={event => setRelayKey(event.target.value)} placeholder="relay encryption key (separate, out-of-band)" type="password" /><input value={token} onChange={event => setToken(event.target.value)} placeholder="access token" type="password" /><input value={deviceId} onChange={event => setDeviceId(event.target.value)} placeholder="device id for refresh" /><input value={refreshToken} onChange={event => setRefreshToken(event.target.value)} placeholder="refresh token" type="password" /><button type="button" onClick={connect}>Connect{relayUrl && relayChannel && relayToken && relayKey ? ' via relay' : ''}</button></section>
    <section style={{ display: 'grid', gap: 8 }}><h2>Pair a device</h2><input value={pairName} onChange={event => setPairName(event.target.value)} placeholder="device name" /><button type="button" onClick={createPairingOffer}>Create local pairing offer</button>{pairingQr !== undefined && <img src={pairingQr} alt="DSHPilot pairing QR code" width={280} height={280} />}{pairingOffer?.workspaceIds !== undefined && <small>Workspace scope: {pairingOffer.workspaceIds.join(', ')}</small>}<input value={pairCode} onChange={event => { setPairCode(event.target.value); setPairingOffer(undefined); setPairingQr(undefined) }} placeholder="one-time code or pairing offer JSON" /><button type="button" onClick={completePairing}>Complete pairing</button></section>
    {server !== undefined && <section><h2>{server.name}</h2><p>Server {server.serverId} · protocol v{server.protocolVersion} · {server.remoteEnabled ? 'remote enabled' : 'loopback only'}</p></section>}
    <section><h2>Sessions ({sessions.length})</h2><select value={selectedSessionId} onChange={event => inspectSession(event.target.value)}><option value="">New session</option>{sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.sessionId} · {session.status}</option>)}</select> <button type="button" onClick={cancelSession} disabled={!selectedSessionId}>Cancel selected</button>{lineage.length > 0 && <p>Lineage: {lineage.map(item => item.sessionId).join(' → ')}</p>}{gitSummary !== undefined && <div><h3>Git / Diff</h3><p>{gitSummary.commit ?? ''} · {gitSummary.branch ?? ''}</p><p>Staged: {gitSummary.staged?.length ?? 0} · Unstaged: {gitSummary.unstaged?.length ?? 0}</p><button type="button" onClick={copyPatch}>Copy patch</button><pre>{gitSummary.diff ?? ''}</pre>{gitSummary.changedFiles?.map(path => <div key={path}><code>{path}</code> <button type="button" onClick={() => openGitPath(path, false)}>Open</button><button type="button" onClick={() => openGitPath(path, true)}>Reveal</button></div>)}</div>}</section>
    <section><h2>Prompt admission</h2><select value={mode} onChange={event => setMode(event.target.value as 'queue' | 'steer')}><option value="queue">Queue</option><option value="steer">Steer current turn</option></select><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} style={{ width: '100%' }} placeholder="This is admitted as a restricted request; execution remains Harness-owned." /><button type="button" onClick={sendPrompt}>Send</button></section>
    <section><h2>Approvals ({permissions.length})</h2>{permissions.map(permission => <div key={permission.permissionId}><span>{permission.tool ?? 'tool'} · {permission.description ?? 'Harness approval required'}</span> <button type="button" onClick={() => answerPermission(permission.permissionId, 'allow')}>Allow once</button><button type="button" onClick={() => answerPermission(permission.permissionId, 'deny')}>Deny</button></div>)}</section>
    <section><h2>Questions ({questions.length})</h2>{questions.map(item => <div key={item.rpcId} style={{ display: 'grid', gap: 8, border: '1px solid #ddd', padding: 8 }}>{item.questions.map(question => { const draft = questionDrafts[`${item.rpcId}:${question.id}`] ?? { selected: [], custom: '' }; return <fieldset key={question.id}><legend>{question.question}</legend><select multiple={question.multiSelect} value={draft.selected} onChange={event => updateQuestionDraft(item.rpcId, question.id, Array.from(event.target.selectedOptions, option => option.value).slice(question.multiSelect ? 0 : -1), draft.custom)}>{question.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description === undefined ? '' : ` — ${option.description}`}</option>)}</select><input value={draft.custom} onChange={event => updateQuestionDraft(item.rpcId, question.id, draft.selected, event.target.value)} placeholder="Custom answer (optional)" /></fieldset> })}<button type="button" onClick={() => answerQuestion(item)}>Submit answers</button></div>)}</section>
    <section><h2>Task Center projection ({tasks.length})</h2>{tasks.map(task => <div key={task.taskId}>{task.taskId} · {task.status}{task.title === undefined ? '' : ` · ${task.title}`}</div>)}</section>
    <section><h2>Notification inbox ({notifications.length})</h2><small>Task completed/failed and other server notifications land here even without OS push permission.</small>{notifications.map(item => <div key={item.id} style={{ display: 'grid', gap: 4, border: '1px solid #ddd', padding: 8 }}><strong>{item.title}</strong><span>{item.at}</span>{item.body === '' ? null : <span style={{ whiteSpace: 'pre-wrap' }}>{item.body}</span>}</div>)}</section>
    <section><h2>Artifacts ({artifacts.length})</h2>{artifacts.map(artifact => <div key={artifact.artifactId}>{artifact.name} · {artifact.bytes} bytes · read-only <button type="button" onClick={() => previewArtifact(artifact)}>Preview</button><button type="button" onClick={() => openArtifact(artifact.artifactId)}>Open</button><button type="button" onClick={() => downloadArtifact(artifact.artifactId, artifact.name)}>Save As</button><button type="button" onClick={() => revealArtifact(artifact.artifactId)}>Reveal</button></div>)}</section>
    <section><h2>Resources ({resources.length})</h2>{resources.map(resource => <div key={resource.resourceId}>{resource.kind} · {resource.label} · {resource.locator} <button type="button" onClick={() => inspectResource(resource.resourceId)}>Inspect</button>{resource.kind === 'folder' && <button type="button" onClick={() => inspectResource(resource.resourceId, 'tree')}>Tree</button>}{(resource.kind === 'file' || resource.kind === 'url') && <button type="button" onClick={() => inspectResource(resource.resourceId, 'read')}>Read</button>}{resourceDetails[resource.resourceId] !== undefined && <pre>{JSON.stringify(resourceDetails[resource.resourceId], null, 2)}</pre>}</div>)}</section>
    <section><h2>Agent output / durable events</h2>{events.slice().reverse().map(event => { const payload = event.payload as { event?: { kind?: string; text?: string } }; return <div key={event.eventId}><code>{event.seq}</code> {event.type} <small>{event.at}</small>{typeof payload.event?.text === 'string' && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{payload.event.text}</pre>}</div> })}</section>
    {error !== undefined && <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</p>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
