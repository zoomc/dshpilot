import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  LocalDocumentProvider, McpManager, inspectTokenUsage, parseMcpImport, validateMcpServer,
  createDesktopNotification, shouldNotify,
  type DocumentAttachmentManifest, type McpImportPreview, type McpServerRecord,
} from '@dshpilot/desktop-host'
import { ControlPlaneServer } from '@dshpilot/remote-daemon'
import type { PermissionSummary, RuntimeStatus, SessionSummary, TaskSummary } from '@dshpilot/control-contracts'

export const pluginName = '@dshpilot/dsh-plugin-desktop'

export const name = 'dshpilot-desktop'
export const inject: readonly string[] = ['webServer', 'apiProxy']

interface HarnessApi {
  sessions: {
    list(request: { rpcId: string; payload: { cursor?: string } }): Promise<{ result: { ok: boolean; value?: { items: readonly HarnessSession[] }; error?: { message?: string } } }>
    create(request: { rpcId: string; payload: { cwd?: string } }): Promise<{ result: { ok: boolean; value?: { sessionId: string }; error?: { message?: string } } }>
    prompt(request: { rpcId: string; payload: { sessionId: string; mode: 'queue' | 'steer'; content: [{ type: 'text'; text: string }] } }): Promise<HarnessRpcResult>
    cancel(request: { rpcId: string; payload: { sessionId: string } }): Promise<HarnessRpcResult>
  }
  events: {
    mux(request: { rpcId: string; payload: { since?: Record<string, number> } }, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: HarnessMuxFrame }>
  }
  respond(message: { type: 'client-response'; rpcId: string; result: { ok: true; value: unknown } | { ok: false; error: unknown } }): Promise<{ accepted: boolean; reason?: string }>
}

interface HarnessRpcResult { result: { ok: boolean; value?: unknown; error?: { message?: string } } }

interface HarnessSession {
  sessionId: string
  updatedAt: number
  running: boolean
  cwd?: string
  projections?: { values?: Record<string, unknown> }
}

type HarnessMuxFrame =
  | { type: 'session/jobs'; sessionId: string; jobs: readonly HarnessJob[] }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'session/event'; sessionId: string; event: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'session/queue'; sessionId: string; items: readonly unknown[] }
  | { type: 'question/requested'; sessionId: string; questions: readonly unknown[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: string }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: unknown }

interface HarnessJob {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}

export interface DesktopHostPluginContext {
  effect?: (callback: () => void | (() => void), label?: string) => unknown
  apiProxy?: HarnessApi
  webServer?: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
  }
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const dshHome = (): string => resolve(process.env.DSH_HOME ?? join(process.cwd(), '.dshpilot-home'))
const dshpilotRoot = (): string => join(dshHome(), 'dshpilot')
const requestId = (): string => `dshpilot-${randomUUID()}`

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, jsonHeaders); response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 512 * 1024) throw new Error('request body is too large'); chunks.push(bytes) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

async function listDocuments(): Promise<DocumentAttachmentManifest[]> {
  const root = join(dshHome(), 'documents', 'v1', 'manifests')
  try {
    const entries = await (await import('node:fs/promises')).readdir(root)
    const manifests: DocumentAttachmentManifest[] = []
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      try { manifests.push(JSON.parse(await readFile(join(root, entry), 'utf8')) as DocumentAttachmentManifest) } catch { /* ignore corrupt individual manifests */ }
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

async function mcpRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const manager = new McpManager(dshHome())
  if (request.method === 'GET') { json(response, 200, { records: await manager.list(), patchPath: manager.patchPath }); return }
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request)
  const action = String(value.action ?? '')
  if (action === 'upsert') { json(response, 200, { records: await manager.upsert(validateMcpServer(value.record as McpServerRecord)) }); return }
  if (action === 'toggle') { json(response, 200, { records: await manager.setEnabled(String(value.id ?? ''), value.enabled === true) }); return }
  if (action === 'remove') { json(response, 200, { records: await manager.remove(String(value.id ?? '')) }); return }
  if (action === 'preview-import') { const existing = await manager.list(); json(response, 200, { preview: parseMcpImport(String(value.text ?? ''), String(value.source ?? 'import.json'), existing) }); return }
  if (action === 'apply-import') { json(response, 200, await manager.import(value.preview as McpImportPreview, value.confirm === true)); return }
  json(response, 400, { error: 'unsupported MCP action' })
}

async function documentRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const provider = new LocalDocumentProvider(dshHome())
  if (request.method === 'GET') { json(response, 200, { manifests: await listDocuments(), manifestOnly: true }); return }
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request)
  if (value.action !== 'add-path' || typeof value.path !== 'string') { json(response, 400, { error: 'only add-path is supported by the local Host adapter' }); return }
  const manifest = await provider.addFile(value.path)
  json(response, 200, { manifest, manifestOnly: true })
}

async function tokenRoute(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  let official: unknown
  if (process.env.DSHPILOT_USAGE_JSON !== undefined) { try { official = JSON.parse(process.env.DSHPILOT_USAGE_JSON) } catch { official = undefined } }
  json(response, 200, { usage: inspectTokenUsage(official, { messages: [], toolSchemas: [], attachmentManifests: [] }), note: official === undefined ? 'Official usage is not exposed by this Harness build; this value is an estimate.' : undefined })
}

async function notificationRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request)
  const notification = createDesktopNotification(String(value.kind ?? '' ) as 'task-completed' | 'task-failed' | 'approval-needed' | 'question-needed', String(value.title ?? ''), String(value.body ?? ''))
  if (shouldNotify(notification)) { await mkdir(dshpilotRoot(), { recursive: true, mode: 0o700 }); await appendFile(join(dshpilotRoot(), 'notifications.jsonl'), `${JSON.stringify(notification)}\n`, { encoding: 'utf8', mode: 0o600 }) }
  json(response, 202, { accepted: shouldNotify(notification), kind: notification.kind })
}

function remoteEnabled(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.DSHPILOT_REMOTE_CONTROL ?? '').toLowerCase())
}

function remoteHost(): string { return process.env.DSHPILOT_REMOTE_HOST ?? '127.0.0.1' }
function remotePort(): number {
  const value = Number(process.env.DSHPILOT_REMOTE_PORT ?? '0')
  return Number.isSafeInteger(value) && value >= 0 && value <= 65_535 ? value : 0
}

function runtimeStatus(): RuntimeStatus {
  return {
    state: 'ready',
    runtimeVersion: process.env.DSHPILOT_RUNTIME_VERSION ?? 'development',
    upstreamSha: process.env.DSHPILOT_UPSTREAM_SHA,
    url: process.env.DSH_WEB_URL,
    pid: process.pid,
    restartCount: 0,
  }
}

function officialValue<T>(result: { result: { ok: boolean; value?: T; error?: { message?: string } } }): T {
  if (!result.result.ok || result.result.value === undefined) throw new Error(result.result.error?.message ?? 'official Harness API request failed')
  return result.result.value
}

function officialSuccess(result: HarnessRpcResult): void {
  if (!result.result.ok) throw new Error(result.result.error?.message ?? 'official Harness API request failed')
}

function remoteWorkspaceRoots(): string[] {
  const configured = (process.env.DSHPILOT_REMOTE_WORKSPACES ?? '').split(',').map(value => value.trim()).filter(Boolean)
  return configured.length > 0 ? configured : [process.env.DSH_WORKSPACE ?? process.cwd()]
}

async function validateRemoteCwd(cwd: string): Promise<string> {
  const target = await realpath(cwd).catch(() => { throw new Error('remote cwd must already exist inside an approved workspace') })
  for (const root of remoteWorkspaceRoots()) {
    const approved = await realpath(root).catch(() => undefined)
    if (approved === undefined) continue
    const child = relative(approved, target)
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) return target
  }
  throw new Error('remote cwd is outside the approved workspace roots')
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return value.slice(0, 160)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  return undefined
}

/** Project official session events to bounded metadata; never persist model/tool/user content remotely. */
function projectHarnessEvent(event: unknown): Record<string, unknown> {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return { kind: 'session-event' }
  const source = event as Record<string, unknown>
  const projected: Record<string, unknown> = { kind: scalar(source.type) ?? scalar(source.kind) ?? 'session-event' }
  for (const key of ['status', 'phase', 'role', 'seq', 'createdAt', 'updatedAt', 'itemCount', 'toolName']) {
    const value = scalar(source[key]); if (value !== undefined) projected[key] = value
  }
  return projected
}

function sessionSummary(session: HarnessSession): SessionSummary {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: session.running ? 'running' : 'idle',
    updatedAt: new Date(session.updatedAt).toISOString(),
  }
}

function createRemoteAdapter(api: HarnessApi): {
  adapter: {
    runtimeStatus: () => RuntimeStatus
    sessions: () => Promise<SessionSummary[]>
    tasks: () => Promise<TaskSummary[]>
    admitPrompt: (request: { requestId: string; sessionId?: string; input: string; cwd?: string }) => Promise<{ taskId: string }>
    interrupt: (sessionId: string) => Promise<void>
    permissions: (sessionId?: string) => Promise<PermissionSummary[]>
    permissionReply: (permissionId: string, decision: 'allow' | 'deny') => Promise<void>
  }
  pump: (server: ControlPlaneServer, signal: AbortSignal) => Promise<void>
} {
  const jobs = new Map<string, HarnessJob>()
  const sessionJobs = new Map<string, Set<string>>()
  const permissions = new Map<string, { summary: PermissionSummary; rpcId: string; sessionId: string; approvalId: string }>()
  const adapter = {
    runtimeStatus,
    sessions: async (): Promise<SessionSummary[]> => {
      const value = officialValue(await api.sessions.list({ rpcId: requestId(), payload: {} }))
      return value.items.map(sessionSummary)
    },
    tasks: async (): Promise<TaskSummary[]> => [...jobs.values()].map(job => ({
      taskId: job.id, status: job.status === 'running' ? 'running' : job.status === 'stopping' ? 'waiting' : job.status === 'completed' ? 'completed' : job.status === 'killed' ? 'cancelled' : 'failed',
      title: job.kind, updatedAt: new Date(job.finishedAt ?? job.startedAt).toISOString(),
    })),
    admitPrompt: async (request: { requestId: string; sessionId?: string; input: string; cwd?: string }): Promise<{ taskId: string }> => {
      let sessionId = request.sessionId
      if (sessionId === undefined) sessionId = officialValue(await api.sessions.create({ rpcId: requestId(), payload: { ...(request.cwd === undefined ? {} : { cwd: await validateRemoteCwd(request.cwd) }) } })).sessionId
      else if (request.cwd !== undefined) await validateRemoteCwd(request.cwd)
      officialSuccess(await api.sessions.prompt({ rpcId: requestId(), payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: request.input }] } }))
      const taskId = `prompt-${request.requestId}`
      jobs.set(taskId, { id: taskId, kind: 'session.prompt', label: 'Session prompt', status: 'running', startedAt: Date.now() })
      return { taskId }
    },
    interrupt: async (sessionId: string): Promise<void> => { officialSuccess(await api.sessions.cancel({ rpcId: requestId(), payload: { sessionId } })) },
    permissions: async (sessionId?: string): Promise<PermissionSummary[]> => [...permissions.values()].map(item => item.summary).filter(item => sessionId === undefined || item.sessionId === sessionId),
    permissionReply: async (permissionId: string, decision: 'allow' | 'deny'): Promise<void> => {
      const pending = permissions.get(permissionId)
      if (pending === undefined) throw new Error('permission is no longer pending')
      const receipt = await api.respond({ type: 'client-response', rpcId: pending.rpcId, result: { ok: true, value: { sessionId: pending.sessionId, approvalId: pending.approvalId, outcome: decision === 'allow' ? 'allowed-once' : 'rejected' } } })
      if (!receipt.accepted) throw new Error(`official Harness rejected permission response: ${receipt.reason ?? 'unknown reason'}`)
      permissions.delete(permissionId)
    },
  }
  const pump = async (server: ControlPlaneServer, signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try {
        for await (const envelope of api.events.mux({ rpcId: requestId(), payload: {} }, signal)) {
          if (signal.aborted) return
          const frame = envelope.payload
          if (frame.type === 'session/jobs') {
            const previous = sessionJobs.get(frame.sessionId) ?? new Set<string>()
            const current = new Set(frame.jobs.map(job => job.id))
            for (const jobId of previous) if (!current.has(jobId)) jobs.delete(jobId)
            for (const job of frame.jobs) jobs.set(job.id, job)
            sessionJobs.set(frame.sessionId, current)
            server.events.append('task.updated', { sessionId: frame.sessionId, jobs: frame.jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt })) })
          } else if (frame.type === 'approval/requested') {
            const permissionId = frame.approvalId
            permissions.set(permissionId, { rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, summary: { permissionId, sessionId: frame.sessionId, tool: frame.toolName, description: frame.reason, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
            server.events.append('permission.requested', { permissionId, sessionId: frame.sessionId, tool: frame.toolName })
          } else if (frame.type === 'approval/resolved') {
            const pending = permissions.get(frame.approvalId)
            if (pending !== undefined) { pending.summary.status = frame.outcome === 'allowed-once' ? 'allowed' : 'denied'; pending.summary.updatedAt = new Date().toISOString(); permissions.delete(frame.approvalId) }
            server.events.append('permission.resolved', { permissionId: frame.approvalId, outcome: frame.outcome })
          } else if (frame.type === 'session/event') {
            server.events.append('task.updated', { sessionId: frame.sessionId, event: projectHarnessEvent(frame.event) })
          } else if (frame.type === 'session/queue') {
            server.events.append('task.updated', { sessionId: frame.sessionId, queueItemCount: frame.items.length })
          } else if (frame.type === 'question/requested') {
            server.events.append('task.updated', { sessionId: frame.sessionId, waitingFor: 'user-question', questionCount: frame.questions.length })
          } else if (frame.type === 'question/resolved') {
            server.events.append('task.updated', { sessionId: frame.sessionId, waitingFor: 'user-question-resolved' })
          } else if (frame.type === 'session/projection') {
            server.events.append('task.updated', { sessionId: frame.sessionId, projection: frame.key.slice(0, 80), seq: frame.seq })
          } else if (frame.type === 'session/subscribed') {
            server.events.append('task.updated', { sessionId: frame.sessionId, subscribed: true, lastSeq: frame.lastSeq })
          } else if (frame.type === 'stream/error') {
            permissions.clear()
            server.events.append('harness.exit', { error: 'official Harness event stream error' })
          }
        }
      } catch (error) {
        if (signal.aborted) return
        permissions.clear()
        server.events.append('harness.exit', { error: 'official Harness event stream disconnected' })
      }
      if (!signal.aborted) await new Promise<void>(resolveSleep => setTimeout(resolveSleep, 500))
    }
  }
  return { adapter, pump }
}

function startRemoteControl(ctx: DesktopHostPluginContext): void {
  if (!remoteEnabled() || ctx.apiProxy === undefined) return
  const host = remoteHost()
  const port = remotePort()
  const tlsKeyPath = process.env.DSHPILOT_REMOTE_TLS_KEY
  const tlsCertPath = process.env.DSHPILOT_REMOTE_TLS_CERT
  const corsOrigins = (process.env.DSHPILOT_REMOTE_CORS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const eventsPath = join(dshpilotRoot(), 'control-events.jsonl')
  const devicesPath = join(dshpilotRoot(), 'devices.json')
  const bridge = createRemoteAdapter(ctx.apiProxy)
  const abort = new AbortController()
  let server: ControlPlaneServer | undefined
  let started = false
  let disposed = false
  const start = async (): Promise<void> => {
    const [{ readFile: read }, { mkdir: makeDir }] = await Promise.all([import('node:fs/promises'), import('node:fs/promises')])
    await makeDir(dshpilotRoot(), { recursive: true, mode: 0o700 })
    const tls = tlsKeyPath !== undefined && tlsCertPath !== undefined ? { key: await read(resolve(tlsKeyPath)), cert: await read(resolve(tlsCertPath)) } : undefined
    server = new ControlPlaneServer({ name: 'DSHPilot self-hosted Harness control plane', version: '0.1.0', host, port, remoteEnabled: true, tls, corsOrigins, eventsPath, devicesPath, relayEnabled: true, allowLocalPairingOffer: process.env.DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING === '1', allowLocalAdminPairing: process.env.DSHPILOT_REMOTE_ALLOW_LOCAL_ADMIN === '1', adapter: bridge.adapter })
    const address = await server.start()
    if (disposed) { await server.stop(); return }
    started = true
    console.log(JSON.stringify({ dshpilotRemote: 'ready', ...address, remoteEnabled: true, tls: tls !== undefined }))
    if (process.env.DSHPILOT_REMOTE_PRINT_PAIRING === '1') console.log(JSON.stringify({ dshpilotPairingOffer: server.devices.createOffer() }))
    void bridge.pump(server, abort.signal).catch(error => { if (!abort.signal.aborted) console.error(`DSHPilot remote event bridge stopped: ${String(error)}`) })
  }
  void start().catch(error => console.error(`DSHPilot remote control failed: ${String(error)}`))
  ctx.effect?.(() => () => {
    disposed = true
    abort.abort()
    if (started && server !== undefined) void server.stop()
  }, 'dshpilot.remote-control')
}

/**
 * Host-side loading sentinel. OS integration remains in Tauri; this plugin is
 * intentionally a small Cordis seam that can be loaded by a Harness profile
 * without introducing a second session or MCP implementation.
 */
export function apply(ctx: DesktopHostPluginContext): void {
  const disposers = [ctx.webServer?.register({
    kind: 'exact', path: '/__dshpilot/health',
    handler: async (_request, response) => {
      let apiReady = false
      if (ctx.apiProxy !== undefined) { try { officialValue(await ctx.apiProxy.sessions.list({ rpcId: requestId(), payload: {} })); apiReady = true } catch { /* health endpoint reports the real API state */ } }
      response.writeHead(apiReady ? 200 : 503, jsonHeaders)
      response.end(JSON.stringify({
        status: 'ready', bootId: process.env.DSHPILOT_BOOT_ID ?? 'development',
        runtimeVersion: process.env.DSHPILOT_RUNTIME_VERSION ?? 'development', harnessVersion: process.env.DSH_VERSION ?? 'unknown',
        webUiReady: true, apiReady,
      }))
    },
  }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/mcp', handler: (request, response) => mcpRoute(request, response) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/documents', handler: (request, response) => documentRoute(request, response) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/tokens', handler: (request, response) => tokenRoute(request, response) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/notifications', handler: (request, response) => notificationRoute(request, response) }),
  ].filter((value): value is () => void => value !== undefined)
  ctx.effect?.(() => () => { for (const dispose of disposers) dispose() }, 'dshpilot.desktop.routes')
  startRemoteControl(ctx)
}

export default { name, inject, apply }
