import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  LocalDocumentProvider, LocalDocumentTools, McpManager, inspectTokenUsage, parseMcpImport, validateMcpServer,
  createDesktopNotification, shouldNotify, officialMcpPluginConfig,
  ArtifactStore, GitPresentation, SessionLineageStore,
  type ResourceReference,
  DocumentProviderRegistry, type DocumentAttachmentManifest, type McpImportPreview, type McpServerRecord, type SessionLineage, validateDocumentManifest,
} from '@dshpilot/desktop-host'
import { ControlPlaneServer } from '@dshpilot/remote-daemon'
import type { PermissionSummary, RuntimeStatus, SessionSummary, TaskSummary } from '@dshpilot/control-contracts'

export const pluginName = '@dshpilot/dsh-plugin-desktop'

export const name = 'dshpilot-desktop'
export const inject: readonly string[] = ['webServer', 'apiProxy', 'tools', 'loader']

interface HarnessApi {
  sessions: {
    list(request: { rpcId: string; payload: { cursor?: string } }): Promise<{ result: { ok: boolean; value?: { items: readonly HarnessSession[] }; error?: { message?: string } } }>
    history?(request: { rpcId: string; payload: { sessionId: string; maxMessages?: number } }): Promise<{ result: { ok: boolean; value?: { events: ReadonlyArray<{ event: { type?: string; data?: unknown } }> }; error?: { message?: string } } }>
    create(request: { rpcId: string; payload: { cwd?: string } }): Promise<{ result: { ok: boolean; value?: { sessionId: string }; error?: { message?: string } } }>
    prompt(request: { rpcId: string; payload: { sessionId: string; mode: 'queue' | 'steer'; content: [{ type: 'text'; text: string }] } }): Promise<HarnessRpcResult>
    cancel(request: { rpcId: string; payload: { sessionId: string } }): Promise<HarnessRpcResult>
  }
  events: {
    mux(request: { rpcId: string; payload: { since?: Record<string, number> } }, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: HarnessMuxFrame }>
  }
  downloads?: {
    sessionLog(request: { sessionId: string; includeDescendants?: boolean }, signal: AbortSignal): Promise<Response>
  }
  respond(message: { type: 'client-response'; rpcId: string; result: { ok: true; value: unknown } | { ok: false; error: unknown } }): Promise<{ accepted: boolean; reason?: string }>
}

interface HarnessRpcResult { result: { ok: boolean; value?: unknown; error?: { message?: string } } }

interface HarnessSession {
  sessionId: string
  updatedAt: number
  running: boolean
  cwd?: string
  parentSessionId?: string
  projections?: { values?: Record<string, unknown> }
}

type HarnessMuxFrame =
  | { type: 'session/jobs'; sessionId: string; jobs: readonly HarnessJob[] }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'session/event'; sessionId: string; event: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'session/queue'; sessionId: string; items: readonly unknown[] }
  | { type: 'question/requested'; sessionId: string; questions: readonly unknown[]; rpcId?: string }
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
  /** Official @deepseek-ai/dsh-tools registry. The plugin only uses its public register seam. */
  tools?: { register(definition: unknown): () => void; schemas?: () => readonly unknown[] }
  loader?: {
    entries(): Iterable<{ id: string; options: { name: string; config?: unknown; disabled?: boolean }; fiber?: { state?: number } }>
    create(options: { name: string; config?: unknown; disabled?: boolean }): Promise<string>
    update(id: string, options: { config?: unknown; disabled?: boolean }): Promise<void>
    remove(id: string): Promise<void>
  }
  webServer?: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
  }
}

interface ToolExecution { signal: AbortSignal }
interface DocumentToolArgs { attachmentId: string; offset?: number; limit?: number; query?: string; maxMatches?: number; sheet?: string | number; range?: string; slide?: number }

export const documentProviders = new DocumentProviderRegistry()
let localProvider: LocalDocumentProvider | undefined
function localDocumentProvider(): LocalDocumentProvider {
  if (localProvider === undefined || localProvider.root !== resolve(join(dshHome(), 'documents', 'v1'))) {
    localProvider = new LocalDocumentProvider(dshHome())
    if (documentProviders.get(localProvider.name) === undefined) documentProviders.register(localProvider)
  }
  return localProvider
}
function providerForManifest(manifest: DocumentAttachmentManifest) {
  const provider = documentProviders.get(manifest.provider)
  if (provider === undefined) throw new Error(`document provider is unavailable: ${manifest.provider}`)
  return provider
}

async function documentManifest(attachmentId: string): Promise<DocumentAttachmentManifest> {
  const manifest = (await listDocuments()).find(item => item.attachmentId === attachmentId)
  if (manifest === undefined) throw new Error('document attachment was not found')
  return manifest
}

function documentToolDefinition(name: string, description: string, properties: Record<string, Record<string, unknown>>, execute: (args: DocumentToolArgs, exec: ToolExecution) => Promise<unknown>): Record<string, unknown> {
  const required = Object.entries(properties).filter(([, value]) => value.required === true).map(([key]) => key)
  const schemaProperties = Object.fromEntries(Object.entries(properties).map(([key, value]) => { const { required: _required, ...schema } = value; return [key, schema] }))
  return {
    name, description, parameters: { type: 'object', properties: schemaProperties, required, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 30_000,
    execute,
  }
}

function registerDocumentTools(ctx: DesktopHostPluginContext): () => void {
  if (ctx.tools === undefined) return () => undefined
  const provider = localDocumentProvider(); const toolsFor = (manifest: DocumentAttachmentManifest): LocalDocumentTools => new LocalDocumentTools(providerForManifest(manifest))
  const definitions = [
    documentToolDefinition('document_inspect', 'Inspect a document attachment without returning its body.', { attachmentId: { type: 'string', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).inspect(manifest, exec.signal) }),
    documentToolDefinition('document_read', 'Read bounded document text or a spreadsheet range on demand.', { attachmentId: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' }, sheet: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, range: { type: 'string' }, slide: { type: 'integer' } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).read(manifest, { offset: args.offset, limit: args.limit, sheet: args.sheet === undefined ? undefined : String(args.sheet), range: args.range, slide: args.slide, signal: exec.signal }) }),
    documentToolDefinition('document_search', 'Search a bounded document projection and return matching lines.', { attachmentId: { type: 'string', required: true }, query: { type: 'string', required: true }, maxMatches: { type: 'integer' } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).search(manifest, args.query ?? '', { maxMatches: args.maxMatches, signal: exec.signal }) }),
    documentToolDefinition('spreadsheet_sheet_info', 'List sheet names and bounded dimensions for an XLSX attachment.', { attachmentId: { type: 'string', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return { sheets: await toolsFor(manifest).spreadsheetSheetInfo(manifest, exec.signal) } }),
    documentToolDefinition('spreadsheet_read_range', 'Read a bounded cell range from an XLSX or CSV attachment.', { attachmentId: { type: 'string', required: true }, sheet: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, range: { type: 'string', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).spreadsheetReadRange(manifest, args.sheet ?? 0, args.range ?? 'A1:Z100', exec.signal) }),
    documentToolDefinition('presentation_slide', 'Read one slide of a PPTX attachment by zero-based index.', { attachmentId: { type: 'string', required: true }, slide: { type: 'integer', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).presentationSlide(manifest, args.slide ?? 0, exec.signal) }),
  ]
  const disposers = definitions.map(definition => ctx.tools!.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const dshHome = (): string => resolve(process.env.DSH_HOME ?? join(process.cwd(), '.dshpilot-home'))
const dshpilotRoot = (): string => join(dshHome(), 'dshpilot')
const requestId = (): string => `dshpilot-${randomUUID()}`
const managedMcpEntryIds = new Set<string>()

function liveMcpConfig(record: McpServerRecord): ReturnType<typeof officialMcpPluginConfig> {
  const config = officialMcpPluginConfig(record)
  for (const [key, environment] of Object.entries(record.envRefs)) if (process.env[environment] !== undefined) config.env[key] = process.env[environment] as string
  for (const [key, environment] of Object.entries(record.headerRefs)) if (process.env[environment] !== undefined) config.headers[key] = process.env[environment] as string
  return config
}

async function boundedResponseBytes(response: Response, maximum = 100 * 1024 * 1024): Promise<Uint8Array> {
  if (!response.ok || response.body === null) throw new Error(`Harness artifact export failed: HTTP ${response.status}`)
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  while (true) {
    const next = await reader.read(); if (next.done) break
    bytes += next.value.byteLength; if (bytes > maximum) throw new Error('Harness artifact export exceeds the remote limit')
    chunks.push(next.value)
  }
  const output = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

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
      try { manifests.push(validateDocumentManifest(JSON.parse(await readFile(join(root, entry), 'utf8')))) } catch { /* ignore corrupt individual manifests */ }
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

async function reconcileMcpLoader(ctx: DesktopHostPluginContext, records: readonly McpServerRecord[]): Promise<{ reloaded: boolean; managedEntries: number }> {
  const loader = ctx.loader
  if (loader === undefined) return { reloaded: false, managedEntries: 0 }
  const desired = new Map(records.map(record => [record.serverName, record]))
  const entries = [...loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')
  const seen = new Set<string>()
  let changed = false
  for (const entry of entries) {
    const config = typeof entry.options.config === 'object' && entry.options.config !== null ? entry.options.config as { serverName?: unknown } : {}
    const serverName = typeof config.serverName === 'string' ? config.serverName : undefined
    const record = serverName === undefined ? undefined : desired.get(serverName)
    if (record === undefined) { if (managedMcpEntryIds.has(entry.id)) { await loader.remove(entry.id); managedMcpEntryIds.delete(entry.id); changed = true } continue }
    seen.add(record.serverName)
    managedMcpEntryIds.add(entry.id)
    await loader.update(entry.id, { disabled: !record.enabled, config: liveMcpConfig(record) })
    changed = true
  }
  for (const record of records) {
    if (seen.has(record.serverName)) continue
    const entryId = await loader.create({ name: '@deepseek-ai/dsh-mcp-client', disabled: !record.enabled, config: liveMcpConfig(record) })
    managedMcpEntryIds.add(entryId)
    changed = true
  }
  return { reloaded: changed, managedEntries: records.length }
}

function liveMcpRecords(ctx: DesktopHostPluginContext, records: readonly McpServerRecord[]): McpServerRecord[] {
  if (ctx.loader === undefined) return [...records]
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')
  const schemas = ctx.tools?.schemas?.() ?? []
  const schemaNames = schemas.flatMap(item => typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? [(item as { name: string }).name] : [])
  return records.map(record => {
    const config = entries.find(entry => typeof entry.options.config === 'object' && entry.options.config !== null && (entry.options.config as { serverName?: unknown }).serverName === record.serverName)
    if (config === undefined) return record
    const status: McpServerRecord['status'] = config.options.disabled === true ? 'disabled' : config.fiber?.state === 3 ? 'failed' : config.fiber?.state === 2 ? 'ready' : 'connecting'
    const toolCount = schemaNames.filter(name => name.startsWith(`mcp__${record.serverName}__`)).length
    return { ...record, status, ...(toolCount === 0 ? {} : { toolCount }) }
  })
}

async function mcpRoute(request: IncomingMessage, response: ServerResponse, ctx: DesktopHostPluginContext): Promise<void> {
  const manager = new McpManager(dshHome())
  if (request.method === 'GET') { const records = await manager.list(); json(response, 200, { records: liveMcpRecords(ctx, records), patchPath: manager.patchPath, liveReload: ctx.loader !== undefined }); return }
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request)
  const action = String(value.action ?? '')
  if (action === 'upsert') { const records = await manager.upsert(validateMcpServer(value.record as McpServerRecord)); json(response, 200, { records, runtime: await reconcileMcpLoader(ctx, records) }); return }
  if (action === 'toggle') { const records = await manager.setEnabled(String(value.id ?? ''), value.enabled === true); json(response, 200, { records, runtime: await reconcileMcpLoader(ctx, records) }); return }
  if (action === 'remove') { const records = await manager.remove(String(value.id ?? '')); json(response, 200, { records, runtime: await reconcileMcpLoader(ctx, records) }); return }
  if (action === 'preview-import') { const existing = await manager.list(); json(response, 200, { preview: parseMcpImport(String(value.text ?? ''), String(value.source ?? 'import.json'), existing) }); return }
  if (action === 'apply-import') { const result = await manager.import(value.preview as McpImportPreview, value.confirm === true); json(response, 200, { ...result, runtime: await reconcileMcpLoader(ctx, result.records) }); return }
  json(response, 400, { error: 'unsupported MCP action' })
}

async function documentRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const provider = localDocumentProvider()
  if (request.method === 'GET') { json(response, 200, { manifests: await listDocuments(), manifestOnly: true }); return }
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request)
  if (value.action === 'add-path' && typeof value.path === 'string') {
    const manifest = await provider.addFile(value.path)
    json(response, 200, { manifest, manifestOnly: true }); return
  }
  const attachmentId = typeof value.attachmentId === 'string' ? value.attachmentId : undefined
  if (attachmentId === undefined) { json(response, 400, { error: 'attachmentId is required' }); return }
  const manifest = (await listDocuments()).find(item => item.attachmentId === attachmentId)
  if (manifest === undefined) { json(response, 404, { error: 'document attachment was not found' }); return }
  const tools = new LocalDocumentTools(providerForManifest(manifest))
  if (value.action === 'inspect') { json(response, 200, await tools.inspect(manifest)); return }
  if (value.action === 'read') { json(response, 200, await tools.read(manifest, { offset: typeof value.offset === 'number' ? value.offset : undefined, limit: typeof value.limit === 'number' ? value.limit : undefined, sheet: typeof value.sheet === 'string' ? value.sheet : undefined, range: typeof value.range === 'string' ? value.range : undefined, slide: typeof value.slide === 'number' ? value.slide : undefined })); return }
  if (value.action === 'search' && typeof value.query === 'string') { json(response, 200, await tools.search(manifest, value.query, { maxMatches: typeof value.maxMatches === 'number' ? value.maxMatches : undefined })); return }
  if (value.action === 'spreadsheet_sheet_info') { json(response, 200, { sheets: await tools.spreadsheetSheetInfo(manifest) }); return }
  if (value.action === 'spreadsheet_read_range' && typeof value.range === 'string') { json(response, 200, await tools.spreadsheetReadRange(manifest, typeof value.sheet === 'number' || typeof value.sheet === 'string' ? value.sheet : 0, value.range)); return }
  if (value.action === 'presentation_slide' && typeof value.slide === 'number') { json(response, 200, await tools.presentationSlide(manifest, value.slide)); return }
  json(response, 400, { error: 'unsupported document action' })
}

async function tokenRoute(request: IncomingMessage, response: ServerResponse, ctx: DesktopHostPluginContext): Promise<void> {
  let official: unknown
  if (process.env.DSHPILOT_USAGE_JSON !== undefined) { try { official = JSON.parse(process.env.DSHPILOT_USAGE_JSON) } catch { official = undefined } }
  const sessionId = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId')
  if (official === undefined && sessionId !== null && ctx.apiProxy?.sessions.history !== undefined) {
    try {
      const history = officialValue(await ctx.apiProxy.sessions.history({ rpcId: requestId(), payload: { sessionId, maxMessages: 200 } }))
      let inputTokens = 0; let outputTokens = 0; let cacheReadTokens = 0; let cacheWriteTokens = 0; let reasoningTokens = 0; let contextWindow: number | undefined
      let hasUsage = false
      for (const entry of history.events) {
        const event = entry.event; const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
        if (event.type === 'assistant/message' && typeof data.usage === 'object' && data.usage !== null) {
          const usage = data.usage as Record<string, unknown>; const number = (key: string): number => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? Math.floor(usage[key] as number) : 0
          inputTokens += number('inputTokens'); outputTokens += number('outputTokens'); cacheReadTokens += number('cacheReadTokens'); cacheWriteTokens += number('cacheWriteTokens'); reasoningTokens += number('reasoningTokens'); hasUsage = true
        }
        if (event.type === 'request/context' && typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow)) contextWindow = Math.floor(data.contextWindow)
      }
      if (hasUsage || contextWindow !== undefined) official = { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }, contextWindow }
    } catch { /* the estimate below is explicit when a history page is unavailable */ }
  }
  json(response, 200, { usage: inspectTokenUsage(official, { messages: [], toolSchemas: ctx.tools?.schemas?.() ?? [], attachmentManifests: [] }), note: official === undefined ? 'Official usage is not exposed by this Harness build; this value is an estimate.' : undefined })
}

async function notificationRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request)
  const notification = createDesktopNotification(String(value.kind ?? '' ) as 'task-completed' | 'task-failed' | 'approval-needed' | 'question-needed', String(value.title ?? ''), String(value.body ?? ''))
  if (shouldNotify(notification)) { await mkdir(dshpilotRoot(), { recursive: true, mode: 0o700 }); const notificationId = typeof value.sourceId === 'string' ? value.sourceId.slice(0, 160) : undefined; const path = join(dshpilotRoot(), 'notifications.jsonl'); const previous = await readFile(path, 'utf8').catch(() => ''); if (notificationId === undefined || !previous.split('\n').some(line => line.includes(`"notificationId":${JSON.stringify(notificationId)}`))) await appendFile(path, `${JSON.stringify({ ...notification, ...(notificationId === undefined ? {} : { notificationId }) })}\n`, { encoding: 'utf8', mode: 0o600 }) }
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

function projectQuestions(value: readonly unknown[]): Array<{ id: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> {
  return value.slice(0, 16).flatMap(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const source = item as Record<string, unknown>; const id = scalar(source.id); const question = scalar(source.question)
    if (typeof id !== 'string' || typeof question !== 'string') return []
    const options = Array.isArray(source.options) ? source.options.slice(0, 32).flatMap(option => { if (typeof option !== 'object' || option === null || Array.isArray(option)) return []; const entry = option as Record<string, unknown>; const label = scalar(entry.label); if (typeof label !== 'string') return []; const description = scalar(entry.description); return [{ label, ...(typeof description === 'string' ? { description } : {}) }] }) : []
    return [{ id, question, options, multiSelect: source.multiSelect === true }]
  })
}

function sessionSummary(session: HarnessSession): SessionSummary {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: session.running ? 'running' : 'idle',
    updatedAt: new Date(session.updatedAt).toISOString(),
  }
}

async function approvedGitPresentation(cwd: string): Promise<{ git: GitPresentation; cwd: string }> {
  const target = await validateRemoteCwd(cwd)
  for (const root of remoteWorkspaceRoots()) {
    const approved = await realpath(root).catch(() => undefined)
    if (approved === undefined) continue
    const child = relative(approved, target)
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) return { git: new GitPresentation(approved), cwd: target }
  }
  throw new Error('remote git cwd is outside the approved workspace roots')
}

async function readResourceReferences(): Promise<ResourceReference[]> {
  const path = join(dshpilotRoot(), 'resources.json')
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(value)) return []
    const kinds = new Set<ResourceReference['kind']>(['file', 'folder', 'git', 'github-pr', 'github-issue', 'url'])
    return value.slice(0, 256).flatMap(item => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const source = item as Record<string, unknown>
      if (typeof source.resourceId !== 'string' || typeof source.label !== 'string' || typeof source.locator !== 'string' || !kinds.has(source.kind as ResourceReference['kind'])) return []
      return [{ resourceId: source.resourceId.slice(0, 128), kind: source.kind as ResourceReference['kind'], label: source.label.slice(0, 160), locator: source.locator.slice(0, 4_096), createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date(0).toISOString() }]
    })
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

function createRemoteAdapter(api: HarnessApi): {
  adapter: {
    runtimeStatus: () => RuntimeStatus
    sessions: () => Promise<SessionSummary[]>
    tasks: () => Promise<TaskSummary[]>
    admitPrompt: (request: { requestId: string; sessionId?: string; input: string; mode?: 'queue' | 'steer'; cwd?: string }) => Promise<{ taskId: string }>
    interrupt: (sessionId: string) => Promise<void>
    permissions: (sessionId?: string) => Promise<PermissionSummary[]>
    permissionReply: (permissionId: string, decision: 'allow' | 'deny') => Promise<void>
    questionReply: (rpcId: string, sessionId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>) => Promise<void>
    artifacts: () => Promise<unknown[]>
    artifactRead: (artifactId: string) => Promise<Uint8Array>
    git: (cwd: string, path?: string) => Promise<unknown>
    resources: () => Promise<unknown[]>
    lineage: (sessionId: string) => Promise<unknown[]>
  }
  hydrate: () => Promise<void>
  pump: (server: ControlPlaneServer, signal: AbortSignal) => Promise<void>
} {
  type PendingPermission = { summary: PermissionSummary; rpcId: string; sessionId: string; approvalId: string }
  type PendingQuestion = { sessionId: string; rpcId: string }
  type RemoteProjection = { schemaVersion: 1; jobs: HarnessJob[]; permissions: PendingPermission[]; questions: PendingQuestion[]; lineage: SessionLineage[] }
  const jobs = new Map<string, HarnessJob>()
  const sessionJobs = new Map<string, Set<string>>()
  const permissions = new Map<string, PendingPermission>()
  const questions = new Map<string, PendingQuestion>()
  const artifacts = new ArtifactStore(dshHome())
  const lineage = new SessionLineageStore()
  const projectionPath = join(dshpilotRoot(), 'remote-projection.json')
  let projectionWriteChain = Promise.resolve()
  const persistProjection = (): void => {
    const snapshot: RemoteProjection = { schemaVersion: 1, jobs: [...jobs.values()], permissions: [...permissions.values()], questions: [...questions.values()], lineage: lineage.list() }
    projectionWriteChain = projectionWriteChain.then(async () => {
      await mkdir(dshpilotRoot(), { recursive: true, mode: 0o700 })
      const { rename, rm, writeFile } = await import('node:fs/promises')
      const temporary = `${projectionPath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 })
      try { await rename(temporary, projectionPath) } catch (error) {
        if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await rm(projectionPath, { force: true }); await rename(temporary, projectionPath)
      }
    }).catch(() => undefined)
  }
  const hydrate = async (): Promise<void> => {
    try {
      const value = JSON.parse(await readFile(projectionPath, 'utf8')) as Partial<RemoteProjection>
      if (value.schemaVersion !== 1) return
      if (Array.isArray(value.jobs)) for (const job of value.jobs) if (typeof job?.id === 'string' && typeof job.kind === 'string' && typeof job.label === 'string' && typeof job.startedAt === 'number') jobs.set(job.id, job)
      if (Array.isArray(value.permissions)) for (const permission of value.permissions) if (permission?.summary?.permissionId !== undefined && permission.summary.status === 'pending') permissions.set(permission.summary.permissionId, permission)
      if (Array.isArray(value.questions)) for (const question of value.questions) if (typeof question?.rpcId === 'string' && typeof question.sessionId === 'string') questions.set(question.rpcId, question)
      if (Array.isArray(value.lineage)) for (const record of value.lineage) if (typeof record?.sessionId === 'string' && typeof record?.rootSessionId === 'string' && typeof record?.createdAt === 'string') lineage.add(record)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`DSHPilot remote projection ignored: ${String(error)}`) }
  }
  const adapter = {
    runtimeStatus,
    sessions: async (): Promise<SessionSummary[]> => {
      const value = officialValue(await api.sessions.list({ rpcId: requestId(), payload: {} }))
      for (const session of value.items) lineage.add({ sessionId: session.sessionId, parentSessionId: session.parentSessionId, rootSessionId: session.parentSessionId === undefined ? session.sessionId : (lineage.lineage(session.parentSessionId)[0]?.rootSessionId ?? session.parentSessionId), createdAt: new Date(session.updatedAt).toISOString() })
      persistProjection()
      return value.items.map(sessionSummary)
    },
    tasks: async (): Promise<TaskSummary[]> => [...jobs.values()].map(job => ({
      taskId: job.id, status: job.status === 'running' ? 'running' : job.status === 'stopping' ? 'waiting' : job.status === 'completed' ? 'completed' : job.status === 'killed' ? 'cancelled' : 'failed',
      title: job.kind, updatedAt: new Date(job.finishedAt ?? job.startedAt).toISOString(),
    })),
    admitPrompt: async (request: { requestId: string; sessionId?: string; input: string; mode?: 'queue' | 'steer'; cwd?: string }): Promise<{ taskId: string }> => {
      let sessionId = request.sessionId
      if (sessionId === undefined) sessionId = officialValue(await api.sessions.create({ rpcId: requestId(), payload: { ...(request.cwd === undefined ? {} : { cwd: await validateRemoteCwd(request.cwd) }) } })).sessionId
      else if (request.cwd !== undefined) await validateRemoteCwd(request.cwd)
      officialSuccess(await api.sessions.prompt({ rpcId: requestId(), payload: { sessionId, mode: request.mode ?? 'queue', content: [{ type: 'text', text: request.input }] } }))
      const taskId = `prompt-${request.requestId}`
      jobs.set(taskId, { id: taskId, kind: 'session.prompt', label: 'Session prompt', status: 'running', startedAt: Date.now() }); persistProjection()
      return { taskId }
    },
    interrupt: async (sessionId: string): Promise<void> => { officialSuccess(await api.sessions.cancel({ rpcId: requestId(), payload: { sessionId } })) },
    permissions: async (sessionId?: string): Promise<PermissionSummary[]> => [...permissions.values()].map(item => item.summary).filter(item => sessionId === undefined || item.sessionId === sessionId),
    permissionReply: async (permissionId: string, decision: 'allow' | 'deny'): Promise<void> => {
      const pending = permissions.get(permissionId)
      if (pending === undefined) throw new Error('permission is no longer pending')
      const receipt = await api.respond({ type: 'client-response', rpcId: pending.rpcId, result: { ok: true, value: { sessionId: pending.sessionId, approvalId: pending.approvalId, outcome: decision === 'allow' ? 'allowed-once' : 'rejected' } } })
      if (!receipt.accepted) throw new Error(`official Harness rejected permission response: ${receipt.reason ?? 'unknown reason'}`)
      permissions.delete(permissionId); persistProjection()
    },
    questionReply: async (rpcId: string, sessionId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): Promise<void> => {
      const pending = questions.get(rpcId)
      if (pending === undefined || pending.sessionId !== sessionId) throw new Error('question is no longer pending')
      const receipt = await api.respond({ type: 'client-response', rpcId, result: { ok: true, value: { sessionId, answer: { answers } } } })
      if (!receipt.accepted) throw new Error(`official Harness rejected question response: ${receipt.reason ?? 'unknown reason'}`)
      questions.delete(rpcId); persistProjection()
    },
    artifacts: async (): Promise<unknown[]> => artifacts.list(),
    artifactRead: async (artifactId: string): Promise<Uint8Array> => artifacts.read(artifactId),
    git: async (cwd: string, path?: string): Promise<unknown> => {
      const target = await approvedGitPresentation(cwd)
      return target.git.summary(target.cwd, path)
    },
    resources: async (): Promise<unknown[]> => readResourceReferences(),
    lineage: async (sessionId: string): Promise<unknown[]> => {
      await adapter.sessions()
      return lineage.lineage(sessionId)
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
            for (const job of frame.jobs) {
              const before = jobs.get(job.id); jobs.set(job.id, job)
              if (before?.status !== job.status && (job.status === 'completed' || job.status === 'failed')) {
                void appendEventNotification(`job-${job.id}-${job.status}`, job.status === 'completed' ? 'task-completed' : 'task-failed', job.status === 'completed' ? 'Harness task completed' : 'Harness task failed', job.label || job.kind)
                if (job.status === 'completed' && api.downloads !== undefined) void api.downloads.sessionLog({ sessionId: frame.sessionId, includeDescendants: true }, signal).then(boundedResponseBytes).then(data => artifacts.put(data, `session-${frame.sessionId}.zip`, 'application/zip')).catch(() => undefined)
              }
            }
            sessionJobs.set(frame.sessionId, current)
            persistProjection()
            server.events.append('task.updated', { sessionId: frame.sessionId, jobs: frame.jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt })) })
          } else if (frame.type === 'approval/requested') {
            const permissionId = frame.approvalId
            permissions.set(permissionId, { rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, summary: { permissionId, sessionId: frame.sessionId, tool: frame.toolName, description: frame.reason, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
            persistProjection()
            server.events.append('permission.requested', { permissionId, sessionId: frame.sessionId, tool: frame.toolName })
            void appendEventNotification(`approval-${permissionId}`, 'approval-needed', 'Approval required', frame.toolName)
          } else if (frame.type === 'approval/resolved') {
            const pending = permissions.get(frame.approvalId)
            if (pending !== undefined) { pending.summary.status = frame.outcome === 'allowed-once' ? 'allowed' : 'denied'; pending.summary.updatedAt = new Date().toISOString(); permissions.delete(frame.approvalId) }
            persistProjection()
            server.events.append('permission.resolved', { permissionId: frame.approvalId, outcome: frame.outcome })
          } else if (frame.type === 'session/event') {
            server.events.append('task.updated', { sessionId: frame.sessionId, event: projectHarnessEvent(frame.event) })
          } else if (frame.type === 'session/queue') {
            server.events.append('task.updated', { sessionId: frame.sessionId, queueItemCount: frame.items.length })
          } else if (frame.type === 'question/requested') {
            const rpcId = frame.rpcId ?? envelope.rpcId; questions.set(rpcId, { sessionId: frame.sessionId, rpcId })
            persistProjection()
            server.events.append('task.updated', { sessionId: frame.sessionId, waitingFor: 'user-question', rpcId, questions: projectQuestions(frame.questions), questionCount: frame.questions.length })
            void appendEventNotification(`question-${rpcId}`, 'question-needed', 'Harness needs an answer', `${frame.questions.length} question${frame.questions.length === 1 ? '' : 's'}`)
          } else if (frame.type === 'question/resolved') {
            questions.delete(frame.questionRpcId); persistProjection()
            server.events.append('task.updated', { sessionId: frame.sessionId, waitingFor: 'user-question-resolved', rpcId: frame.questionRpcId })
          } else if (frame.type === 'session/projection') {
            server.events.append('task.updated', { sessionId: frame.sessionId, projection: frame.key.slice(0, 80), seq: frame.seq })
          } else if (frame.type === 'session/subscribed') {
            server.events.append('task.updated', { sessionId: frame.sessionId, subscribed: true, lastSeq: frame.lastSeq })
          } else if (frame.type === 'stream/error') {
            server.events.append('harness.exit', { error: 'official Harness event stream error' })
          }
        }
      } catch (error) {
        if (signal.aborted) return
        server.events.append('harness.exit', { error: 'official Harness event stream disconnected' })
      }
      if (!signal.aborted) await new Promise<void>(resolveSleep => setTimeout(resolveSleep, 500))
    }
  }
  async function appendEventNotification(sourceId: string, kind: 'task-completed' | 'task-failed' | 'approval-needed' | 'question-needed', title: string, bodyText: string): Promise<void> {
    const notification = createDesktopNotification(kind, title, bodyText); await mkdir(dshpilotRoot(), { recursive: true, mode: 0o700 }); const path = join(dshpilotRoot(), 'notifications.jsonl'); const previous = await readFile(path, 'utf8').catch(() => ''); if (previous.split('\n').some(line => line.includes(`"notificationId":${JSON.stringify(sourceId)}`))) return; await appendFile(path, `${JSON.stringify({ ...notification, notificationId: sourceId })}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  return { adapter, hydrate, pump }
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
    await bridge.hydrate()
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
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/plugin-status', handler: (_request, response) => {
    json(response, 200, {
      hostPlugin: true,
      plugin: name,
      officialServices: { webServer: ctx.webServer !== undefined, apiProxy: ctx.apiProxy !== undefined, tools: ctx.tools !== undefined },
      documentTools: ['document_inspect', 'document_read', 'document_search', 'spreadsheet_sheet_info', 'spreadsheet_read_range', 'presentation_slide'],
      registeredToolSchemas: ctx.tools?.schemas?.().length ?? undefined,
    })
  }}),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/mcp', handler: (request, response) => mcpRoute(request, response, ctx) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/documents', handler: (request, response) => documentRoute(request, response) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/tokens', handler: (request, response) => tokenRoute(request, response, ctx) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/notifications', handler: (request, response) => notificationRoute(request, response) }),
  ].filter((value): value is () => void => value !== undefined)
  ctx.effect?.(() => () => { for (const dispose of disposers) dispose() }, 'dshpilot.desktop.routes')
  const disposeDocumentTools = registerDocumentTools(ctx)
  ctx.effect?.(() => disposeDocumentTools, 'dshpilot.document-tools')
  if (ctx.loader !== undefined) {
    void new McpManager(dshHome()).list().then(records => reconcileMcpLoader(ctx, records)).catch(error => console.error(`DSHPilot MCP startup reconcile failed: ${String(error)}`))
  }
  startRemoteControl(ctx)
}

export default { name, inject, apply }
