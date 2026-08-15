import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteControlClient } from '@dshpilot/remote-client'
import type { ControlEvent, PairingOffer, PermissionSummary, ServerInfo, SessionSummary } from '@dshpilot/control-contracts'

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
type Artifact = { artifactId: string; name: string; bytes: number }
type Resource = { resourceId: string; kind: string; label: string; locator: string }

function App() {
  const [endpoint, setEndpoint] = useState(saved('dshpilot.endpoint') || 'http://127.0.0.1:6767')
  const [token, setToken] = useState(saved('dshpilot.token'))
  const [refreshToken, setRefreshToken] = useState(saved('dshpilot.refresh'))
  const [deviceId, setDeviceId] = useState(saved('dshpilot.device'))
  const [pairCode, setPairCode] = useState('')
  const [pairingOffer, setPairingOffer] = useState<PairingOffer | undefined>()
  const [pairName, setPairName] = useState('Remote PWA')
  const [server, setServer] = useState<ServerInfo | undefined>()
  const [events, setEvents] = useState<ControlEvent[]>(() => cached('dshpilot.remote.events', []))
  const [tasks, setTasks] = useState<Array<{ taskId: string; status: string; title?: string }>>(() => cached('dshpilot.remote.tasks', []))
  const [sessions, setSessions] = useState<SessionSummary[]>(() => cached('dshpilot.remote.sessions', []))
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [mode, setMode] = useState<'queue' | 'steer'>('queue')
  const [permissions, setPermissions] = useState<PermissionSummary[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [resources, setResources] = useState<Resource[]>([])
  const [lineage, setLineage] = useState<Array<{ sessionId: string; parentSessionId?: string }>>([])
  const [gitSummary, setGitSummary] = useState<{ branch?: string; status?: string; diff?: string; commit?: string }>()
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({})
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | undefined>()
  const streamAbort = useRef<AbortController | undefined>(undefined)
  const client = useMemo(() => new RemoteControlClient({ baseUrl: endpoint, token: token || undefined, refreshToken: refreshToken || undefined, deviceId: deviceId || undefined }), [endpoint, token, refreshToken, deviceId])

  const connectClient = (activeClient: RemoteControlClient): void => {
    streamAbort.current?.abort()
    const controller = new AbortController(); streamAbort.current = controller
    void activeClient.serverInfo().then(setServer).then(async () => {
      const [page, nextTasks, nextSessions, nextPermissions, nextArtifacts, nextResources] = await Promise.all([
        activeClient.events(0), activeClient.tasks(), activeClient.sessions(), activeClient.permissions(),
        activeClient.artifacts<Artifact>(), activeClient.resources<Resource>(),
      ])
      setEvents(page.events); setTasks(nextTasks); setSessions(nextSessions); setPermissions(nextPermissions); setArtifacts(nextArtifacts); setResources(nextResources)
      setSelectedSessionId(current => current || nextSessions[0]?.sessionId || '')
      return activeClient.streamEvents({ after: page.latestSeq, generation: page.generation, signal: controller.signal, onEvent: event => {
        setEvents(current => [...current.slice(-99), event])
        if (event.type !== 'task.updated') return
        const payload = event.payload as { waitingFor?: string; rpcId?: string; sessionId?: string; questions?: PendingQuestion['questions'] }
        if (payload.waitingFor === 'user-question' && payload.rpcId !== undefined && payload.sessionId !== undefined && payload.questions !== undefined) setQuestions(current => [...current.filter(item => item.rpcId !== payload.rpcId), { rpcId: payload.rpcId!, sessionId: payload.sessionId!, questions: payload.questions! }])
        if (payload.waitingFor === 'user-question-resolved' && payload.rpcId !== undefined) setQuestions(current => current.filter(item => item.rpcId !== payload.rpcId))
        void activeClient.sessions().then(setSessions); void activeClient.tasks().then(setTasks); void activeClient.permissions().then(setPermissions)
      } })
    }).catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)) })
  }
  const connect = (): void => { persist('dshpilot.endpoint', endpoint); persist('dshpilot.token', token); persist('dshpilot.refresh', refreshToken); persist('dshpilot.device', deviceId); connectClient(client) }
  const sendPrompt = (): void => { if (!prompt.trim()) return; void client.control({ kind: 'prompt_admission', requestId: crypto.randomUUID(), ...(selectedSessionId ? { sessionId: selectedSessionId } : {}), mode, input: prompt }).then(() => setPrompt('')).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const cancelSession = (): void => { if (!selectedSessionId) return; void client.interrupt(selectedSessionId).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const answerPermission = (permissionId: string, decision: 'allow' | 'deny'): void => { void client.permissionReply(permissionId, decision).then(() => setPermissions(current => current.filter(item => item.permissionId !== permissionId))).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const updateQuestionDraft = (rpcId: string, questionId: string, selected: string[], custom: string): void => { setQuestionDrafts(current => ({ ...current, [`${rpcId}:${questionId}`]: { selected, custom } })) }
  const answerQuestion = (pending: PendingQuestion): void => {
    const answers = pending.questions.map(question => { const draft = questionDrafts[`${pending.rpcId}:${question.id}`] ?? { selected: [], custom: '' }; return { id: question.id, selected: draft.selected, ...(draft.custom.trim() === '' ? {} : { custom: draft.custom.trim() }) } })
    void client.control({ kind: 'question_reply', requestId: crypto.randomUUID(), rpcId: pending.rpcId, sessionId: pending.sessionId, answers }).then(() => { setQuestions(current => current.filter(item => item.rpcId !== pending.rpcId)); setQuestionDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${pending.rpcId}:`)))) }).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  const createPairingOffer = (): void => { void client.pairingOffer().then(offer => { setPairingOffer(offer); setPairCode(offer.code) }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const completePairing = (): void => {
    const pastedOffer = parsePairingOffer(pairCode.trim()); const offer = pastedOffer ?? pairingOffer; const code = offer?.code ?? pairCode.trim()
    if (code === '') { setError('请输入 pairing code 或完整 pairing offer JSON'); return }
    void client.pair(code, pairName, offer).then(result => { setToken(result.token); setRefreshToken(result.refreshToken); setDeviceId(result.device.deviceId); persist('dshpilot.token', result.token); persist('dshpilot.refresh', result.refreshToken); persist('dshpilot.device', result.device.deviceId); connectClient(new RemoteControlClient({ baseUrl: endpoint, token: result.token, refreshToken: result.refreshToken, deviceId: result.device.deviceId })) }).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  const inspectSession = (sessionId: string): void => { setSelectedSessionId(sessionId); void client.lineage<{ sessionId: string; parentSessionId?: string }>(sessionId).then(setLineage).catch(value => setError(value instanceof Error ? value.message : String(value))); const cwd = sessions.find(session => session.sessionId === sessionId)?.cwd; if (cwd !== undefined) void client.git<{ branch?: string; status?: string; diff?: string; commit?: string }>(cwd).then(setGitSummary).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  const downloadArtifact = (artifactId: string, name: string): void => { void client.artifactRead(artifactId).then(bytes => { const link = document.createElement('a'); const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; link.href = URL.createObjectURL(new Blob([body])); link.download = name; link.click(); URL.revokeObjectURL(link.href) }).catch(value => setError(value instanceof Error ? value.message : String(value))) }
  useEffect(() => { if (token) connect(); return () => streamAbort.current?.abort() }, [])
  useEffect(() => { cache('dshpilot.remote.events', events.slice(-200)); cache('dshpilot.remote.tasks', tasks); cache('dshpilot.remote.sessions', sessions) }, [events, tasks, sessions])

  return <main style={{ maxWidth: 860, margin: '0 auto', padding: 24, fontFamily: 'system-ui' }}>
    <h1>DSHPilot Remote</h1><p>Self-hosted, restricted control plane. The PWA never receives the Harness process or OS credentials.</p>
    <section style={{ display: 'grid', gap: 8 }}><input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://host:port" /><input value={token} onChange={event => setToken(event.target.value)} placeholder="access token" type="password" /><input value={deviceId} onChange={event => setDeviceId(event.target.value)} placeholder="device id for refresh" /><input value={refreshToken} onChange={event => setRefreshToken(event.target.value)} placeholder="refresh token" type="password" /><button type="button" onClick={connect}>Connect</button></section>
    <section style={{ display: 'grid', gap: 8 }}><h2>Pair a device</h2><input value={pairName} onChange={event => setPairName(event.target.value)} placeholder="device name" /><button type="button" onClick={createPairingOffer}>Create local pairing offer</button><input value={pairCode} onChange={event => { setPairCode(event.target.value); setPairingOffer(undefined) }} placeholder="one-time code or pairing offer JSON" /><button type="button" onClick={completePairing}>Complete pairing</button></section>
    {server !== undefined && <section><h2>{server.name}</h2><p>Server {server.serverId} · protocol v{server.protocolVersion} · {server.remoteEnabled ? 'remote enabled' : 'loopback only'}</p></section>}
    <section><h2>Sessions ({sessions.length})</h2><select value={selectedSessionId} onChange={event => inspectSession(event.target.value)}><option value="">New session</option>{sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.sessionId} · {session.status}</option>)}</select> <button type="button" onClick={cancelSession} disabled={!selectedSessionId}>Cancel selected</button>{lineage.length > 0 && <p>Lineage: {lineage.map(item => item.sessionId).join(' → ')}</p>}{gitSummary !== undefined && <pre>{`${gitSummary.commit ?? ''}\n${gitSummary.branch ?? ''}\n${gitSummary.status ?? ''}\n${gitSummary.diff ?? ''}`}</pre>}</section>
    <section><h2>Prompt admission</h2><select value={mode} onChange={event => setMode(event.target.value as 'queue' | 'steer')}><option value="queue">Queue</option><option value="steer">Steer current turn</option></select><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} style={{ width: '100%' }} placeholder="This is admitted as a restricted request; execution remains Harness-owned." /><button type="button" onClick={sendPrompt}>Send</button></section>
    <section><h2>Approvals ({permissions.length})</h2>{permissions.map(permission => <div key={permission.permissionId}><span>{permission.tool ?? 'tool'} · {permission.description ?? 'Harness approval required'}</span> <button type="button" onClick={() => answerPermission(permission.permissionId, 'allow')}>Allow once</button><button type="button" onClick={() => answerPermission(permission.permissionId, 'deny')}>Deny</button></div>)}</section>
    <section><h2>Questions ({questions.length})</h2>{questions.map(item => <div key={item.rpcId} style={{ display: 'grid', gap: 8, border: '1px solid #ddd', padding: 8 }}>{item.questions.map(question => { const draft = questionDrafts[`${item.rpcId}:${question.id}`] ?? { selected: [], custom: '' }; return <fieldset key={question.id}><legend>{question.question}</legend><select multiple={question.multiSelect} value={draft.selected} onChange={event => updateQuestionDraft(item.rpcId, question.id, Array.from(event.target.selectedOptions, option => option.value).slice(question.multiSelect ? 0 : -1), draft.custom)}>{question.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description === undefined ? '' : ` — ${option.description}`}</option>)}</select><input value={draft.custom} onChange={event => updateQuestionDraft(item.rpcId, question.id, draft.selected, event.target.value)} placeholder="Custom answer (optional)" /></fieldset> })}<button type="button" onClick={() => answerQuestion(item)}>Submit answers</button></div>)}</section>
    <section><h2>Task Center projection ({tasks.length})</h2>{tasks.map(task => <div key={task.taskId}>{task.taskId} · {task.status}{task.title === undefined ? '' : ` · ${task.title}`}</div>)}</section>
    <section><h2>Artifacts ({artifacts.length})</h2>{artifacts.map(artifact => <div key={artifact.artifactId}>{artifact.name} · {artifact.bytes} bytes · read-only <button type="button" onClick={() => downloadArtifact(artifact.artifactId, artifact.name)}>Save As</button></div>)}</section>
    <section><h2>Resources ({resources.length})</h2>{resources.map(resource => <div key={resource.resourceId}>{resource.kind} · {resource.label} · {resource.locator}</div>)}</section>
    <section><h2>Durable events</h2>{events.slice().reverse().map(event => <div key={event.eventId}><code>{event.seq}</code> {event.type} <small>{event.at}</small></div>)}</section>
    {error !== undefined && <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</p>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
