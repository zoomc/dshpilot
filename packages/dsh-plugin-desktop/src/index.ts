import { appendFile, readFile, mkdir, readdir, stat, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  LocalDocumentProvider, LocalDocumentTools, McpManager, inspectTokenUsage, parseMcpImport, validateMcpServer,
  createDesktopNotification, shouldNotify, officialMcpPluginConfig, resolveOfficialMcpPluginConfig,
  ArtifactStore, GitPresentation, SessionLineageStore, ResourceProviderRegistry, isPathInside,
  type ResourceReference, type ResourceOperation,
  DocumentProviderRegistry, type DocumentAttachmentManifest, type McpImportPreview, type McpServerRecord, type SessionLineage, validateDocumentManifest,
} from '@dshpilot/desktop-host'
import { ControlPlaneServer, RestrictedRelayTunnel } from '@dshpilot/remote-daemon'
import type { PermissionSummary, RuntimeStatus, SessionSummary, TaskSummary } from '@dshpilot/control-contracts'

const execFileAsync = promisify(execFile)

export const pluginName = '@dshpilot/dsh-plugin-desktop'

export const name = 'dshpilot-desktop'
export const inject: readonly string[] = ['webServer', 'apiProxy', 'tools', 'loader', 'credentials']

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
  sessionId?: string
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
  /** Official @deepseek-ai/dsh-credentials service; values are resolved per loader reconcile and never persisted. */
  credentials?: {
    resolve(ref: string): Promise<{ value: string; source?: string } | undefined>
    describe?(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
    set?(ref: string, value: string): Promise<void>
    unset?(ref: string): Promise<void>
  }
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
interface ResourceToolArgs { resourceId: string; offset?: number; limit?: number; query?: string; path?: string }

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
    documentToolDefinition('document_read', 'Read bounded document text or a spreadsheet range on demand.', { attachmentId: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' }, sheet: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, range: { type: 'string' }, slide: { type: 'integer' } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).read(manifest, { offset: args.offset, limit: args.limit, sheet: args.sheet, range: args.range, slide: args.slide, signal: exec.signal }) }),
    documentToolDefinition('document_search', 'Search a bounded document projection and return matching lines.', { attachmentId: { type: 'string', required: true }, query: { type: 'string', required: true }, maxMatches: { type: 'integer' } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).search(manifest, args.query ?? '', { maxMatches: args.maxMatches, signal: exec.signal }) }),
    documentToolDefinition('spreadsheet_sheet_info', 'List sheet names and bounded dimensions for an XLSX attachment.', { attachmentId: { type: 'string', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return { sheets: await toolsFor(manifest).spreadsheetSheetInfo(manifest, exec.signal) } }),
    documentToolDefinition('spreadsheet_read_range', 'Read a bounded cell range from an XLSX or CSV attachment.', { attachmentId: { type: 'string', required: true }, sheet: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, range: { type: 'string', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).spreadsheetReadRange(manifest, args.sheet ?? 0, args.range ?? 'A1:Z100', exec.signal) }),
    documentToolDefinition('presentation_slide', 'Read one slide of a PPTX attachment by zero-based index.', { attachmentId: { type: 'string', required: true }, slide: { type: 'integer', required: true } }, async (args, exec) => { const manifest = await documentManifest(args.attachmentId); return toolsFor(manifest).presentationSlide(manifest, args.slide ?? 0, exec.signal) }),
  ]
  const disposers = definitions.map(definition => ctx.tools!.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

function resourceToolDefinition(name: string, description: string, properties: Record<string, Record<string, unknown>>, operation: ResourceOperation): Record<string, unknown> {
  const required = Object.entries(properties).filter(([, value]) => value.required === true).map(([key]) => key)
  const schemaProperties = Object.fromEntries(Object.entries(properties).map(([key, value]) => { const { required: _required, ...schema } = value; return [key, schema] }))
  return {
    name, description, parameters: { type: 'object', properties: schemaProperties, required, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 30_000,
    execute: async (args: ResourceToolArgs): Promise<unknown> => {
      const resource = (await readResourceReferences()).find(item => item.resourceId === args.resourceId)
      if (resource === undefined) throw new Error('resource was not found')
      return resourceProviders.resolve(resource, operation, { ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.query === undefined ? {} : { query: args.query }), ...(args.path === undefined ? {} : { path: args.path }) })
    },
  }
}

function registerResourceTools(ctx: DesktopHostPluginContext): () => void {
  if (ctx.tools === undefined) return () => undefined
  registerResourceProviders()
  const definitions = [
    resourceToolDefinition('resource_inspect', 'Inspect an attached file, folder, repository, GitHub reference, or URL.', { resourceId: { type: 'string', required: true } }, 'inspect'),
    resourceToolDefinition('resource_tree', 'List a bounded attached folder or repository tree.', { resourceId: { type: 'string', required: true } }, 'tree'),
    resourceToolDefinition('resource_search', 'Search a bounded attached file, folder, or repository.', { resourceId: { type: 'string', required: true }, query: { type: 'string', required: true } }, 'search'),
    resourceToolDefinition('resource_read', 'Read bounded content from an attached file, repository path, GitHub reference, or URL.', { resourceId: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' }, path: { type: 'string' } }, 'read'),
    resourceToolDefinition('resource_diff', 'Read a bounded repository diff for an attached Git resource.', { resourceId: { type: 'string', required: true }, path: { type: 'string' } }, 'diff'),
    resourceToolDefinition('resource_history', 'Read recent commit summaries for an attached Git resource.', { resourceId: { type: 'string', required: true } }, 'history'),
  ]
  const disposers = definitions.map(definition => ctx.tools!.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const dshHome = (): string => resolve(process.env.DSH_HOME ?? join(process.cwd(), '.dshpilot-home'))
const dshpilotRoot = (): string => join(dshHome(), 'dshpilot')
const requestId = (): string => `dshpilot-${randomUUID()}`
const managedMcpEntryIds = new Set<string>()

async function liveMcpConfig(ctx: DesktopHostPluginContext, record: McpServerRecord): Promise<ReturnType<typeof officialMcpPluginConfig>> {
  if (Object.keys(record.envRefs).length > 0 || Object.keys(record.headerRefs).length > 0) {
    if (ctx.credentials === undefined) throw new Error(`${record.id}: official credentials service is required for credential references`)
    return resolveOfficialMcpPluginConfig(record, ctx.credentials)
  }
  return officialMcpPluginConfig(record)
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

export async function reconcileMcpLoader(ctx: DesktopHostPluginContext, records: readonly McpServerRecord[]): Promise<{ reloaded: boolean; managedEntries: number }> {
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
    if (seen.has(record.serverName)) {
      // A duplicate namespace cannot be a valid official MCP composition. Only
      // remove duplicates DSHPilot created in this process; user-owned entries
      // remain untouched and are surfaced by the official Loader diagnostics.
      if (managedMcpEntryIds.has(entry.id)) { await loader.remove(entry.id); managedMcpEntryIds.delete(entry.id); changed = true }
      continue
    }
    seen.add(record.serverName)
    managedMcpEntryIds.add(entry.id)
    const nextConfig = await liveMcpConfig(ctx, record)
    const sameConfig = JSON.stringify(entry.options.config) === JSON.stringify(nextConfig)
    const sameDisabled = entry.options.disabled === !record.enabled
    if (!sameConfig || !sameDisabled) {
      await loader.update(entry.id, { disabled: !record.enabled, config: nextConfig })
      changed = true
    }
  }
  for (const record of records) {
    if (seen.has(record.serverName)) continue
    const entryId = await loader.create({ name: '@deepseek-ai/dsh-mcp-client', disabled: !record.enabled, config: await liveMcpConfig(ctx, record) })
    managedMcpEntryIds.add(entryId)
    changed = true
  }
  return { reloaded: changed, managedEntries: records.length }
}

export function liveMcpRecords(ctx: DesktopHostPluginContext, records: readonly McpServerRecord[]): McpServerRecord[] {
  if (ctx.loader === undefined) return [...records]
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')
  const schemas = ctx.tools?.schemas?.() ?? []
  const schemaNames = schemas.flatMap(item => typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? [(item as { name: string }).name] : [])
  return records.map(record => {
    const config = entries.find(entry => typeof entry.options.config === 'object' && entry.options.config !== null && (entry.options.config as { serverName?: unknown }).serverName === record.serverName)
    if (config === undefined) return { ...record, status: record.enabled ? 'configured' : 'disabled', statusSource: 'persisted', toolCount: undefined, toolCountSource: undefined }
    // Cordis FiberState is the official Loader lifecycle source:
    // PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5.
    const status: McpServerRecord['status'] = config.options.disabled === true
      ? 'disabled'
      : config.fiber?.state === 3
        ? 'failed'
        : config.fiber?.state === 2
          ? 'ready'
          : config.fiber?.state === 4 || config.fiber?.state === 5
            ? 'reconnecting'
            : 'connecting'
    const toolCount = schemaNames.filter(name => name.startsWith(`mcp__${record.serverName}__`)).length
    return { ...record, status, statusSource: 'loader-fiber', toolCount, toolCountSource: 'tools-registry' }
  })
}

export async function restartMcpLoader(ctx: DesktopHostPluginContext, record: McpServerRecord): Promise<{ restarted: boolean; managedEntries: number }> {
  if (ctx.loader === undefined) return { restarted: false, managedEntries: 0 }
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client' && typeof entry.options.config === 'object' && entry.options.config !== null && (entry.options.config as { serverName?: unknown }).serverName === record.serverName)
  if (entries.length === 0) { const result = await reconcileMcpLoader(ctx, [record]); return { restarted: result.reloaded, managedEntries: result.managedEntries } }
  for (const entry of entries) {
    await ctx.loader.update(entry.id, { disabled: true })
    await ctx.loader.update(entry.id, { disabled: !record.enabled, config: await liveMcpConfig(ctx, record) })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const state = entry.fiber?.state
      if (record.enabled === false || entry.fiber === undefined || state === 2 || state === 3) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  return { restarted: true, managedEntries: entries.length }
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
  if (action === 'restart') { const records = await manager.list(); const record = records.find(item => item.id === String(value.id ?? '')); if (record === undefined) { json(response, 404, { error: 'MCP server was not found' }); return } json(response, 200, { records: liveMcpRecords(ctx, records), runtime: await restartMcpLoader(ctx, record) }); return }
  if (action === 'credential-status') { const ref = String(value.ref ?? ''); if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref) || ctx.credentials?.describe === undefined) { json(response, 400, { error: 'credential describe is unavailable' }); return } json(response, 200, { ref, status: await ctx.credentials.describe(ref) }); return }
  if (action === 'credential-set') { const ref = String(value.ref ?? ''); const secret = typeof value.value === 'string' ? value.value : ''; if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref) || secret.length === 0 || ctx.credentials?.set === undefined) { json(response, 400, { error: 'credential set is unavailable or invalid' }); return } await ctx.credentials.set(ref, secret); json(response, 204, {}); return }
  if (action === 'credential-unset') { const ref = String(value.ref ?? ''); if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref) || ctx.credentials?.unset === undefined) { json(response, 400, { error: 'credential unset is unavailable' }); return } await ctx.credentials.unset(ref); json(response, 204, {}); return }
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
  if (value.action === 'read') { json(response, 200, await tools.read(manifest, { offset: typeof value.offset === 'number' ? value.offset : undefined, limit: typeof value.limit === 'number' ? value.limit : undefined, sheet: typeof value.sheet === 'string' || typeof value.sheet === 'number' ? value.sheet : undefined, range: typeof value.range === 'string' ? value.range : undefined, slide: typeof value.slide === 'number' ? value.slide : undefined })); return }
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
      let latestUsage: Record<string, number | undefined> | undefined; let contextWindow: number | undefined
      for (const entry of history.events) {
        const event = entry.event; const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
        if (event.type === 'assistant/message' && typeof data.usage === 'object' && data.usage !== null) {
          const usage = data.usage as Record<string, unknown>; const number = (key: string): number | undefined => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? Math.floor(usage[key] as number) : undefined
          latestUsage = Object.fromEntries(Object.entries({ inputTokens: number('inputTokens'), outputTokens: number('outputTokens'), cacheReadTokens: number('cacheReadTokens'), cacheWriteTokens: number('cacheWriteTokens'), reasoningTokens: number('reasoningTokens') }).filter(([, value]) => value !== undefined))
        }
        if (event.type === 'request/context' && typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow)) contextWindow = Math.floor(data.contextWindow)
      }
      if (latestUsage !== undefined || contextWindow !== undefined) official = { usage: latestUsage ?? {}, contextWindow }
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

function safeRemoteText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, 16_384)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[redacted-secret]')
    .replace(/\b(?:ghp|github_pat|xoxb|xoxp)_[A-Za-z0-9_-]{12,}\b/gu, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu, 'Bearer [redacted-secret]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted-secret]')
}

function textFromContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const block = item as Record<string, unknown>; return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('')
  return safeRemoteText(text)
}

/** Project official session events to bounded metadata; expose only redacted assistant text. */
export function projectHarnessEvent(event: unknown): Record<string, unknown> {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return { kind: 'session-event' }
  const source = event as Record<string, unknown>
  const projected: Record<string, unknown> = { kind: scalar(source.type) ?? scalar(source.kind) ?? 'session-event' }
  for (const key of ['status', 'phase', 'role', 'seq', 'createdAt', 'updatedAt', 'itemCount', 'toolName']) {
    const value = scalar(source[key]); if (value !== undefined) projected[key] = value
  }
  if (source.type === 'assistant/message') {
    const data = typeof source.data === 'object' && source.data !== null ? source.data as Record<string, unknown> : {}
    const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : data
    const text = textFromContent(message.content); if (text !== undefined) projected.text = text
  } else if (source.type === 'assistant/chunk') {
    const data = typeof source.data === 'object' && source.data !== null ? source.data as Record<string, unknown> : {}
    const chunk = typeof data.chunk === 'object' && data.chunk !== null ? data.chunk as Record<string, unknown> : data
    const text = safeRemoteText(chunk.text); if (text !== undefined) projected.text = text
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

async function approvedGitPath(cwd: string, path: string): Promise<string> {
  const target = await validateRemoteCwd(cwd); const candidate = resolve(target, path); if (!isPathInside(target, candidate)) throw new Error('remote git path is outside the approved workspace')
  const realTarget = await realpath(candidate).catch(() => { throw new Error('remote git path does not exist') }); if (!isPathInside(target, realTarget)) throw new Error('remote git path symlink escapes the workspace'); return realTarget
}

async function openApprovedPath(cwd: string, path: string, reveal: boolean): Promise<{ opened: boolean }> {
  const target = await approvedGitPath(cwd, path); const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'; const args = reveal ? (process.platform === 'darwin' ? ['-R', target] : process.platform === 'win32' ? [`/select,${target}`] : [dirname(target)]) : [target]
  try { await execFileAsync(command, args, { timeout: 15_000 }); return { opened: true } } catch { return { opened: false } }
}

export const resourceProviders = new ResourceProviderRegistry()
let resourceProvidersReady = false
const resourceKinds = new Set<ResourceReference['kind']>(['file', 'folder', 'git', 'github-repository', 'github-pr', 'github-issue', 'url'])

function boundedNumber(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback
}

async function readBoundedFile(path: string, offset = 0, limit = 2 * 1024 * 1024): Promise<{ content: string; offset: number; bytes: number; truncated: boolean }> {
  const data = await readFile(path)
  const start = Math.min(offset, data.byteLength); const end = Math.min(data.byteLength, start + limit)
  return { content: data.subarray(start, end).toString('utf8'), offset: start, bytes: data.byteLength, truncated: end < data.byteLength }
}

function githubEndpoint(resource: ResourceReference): string {
  const url = new URL(resource.locator)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('GitHub resource must use an https://github.com locator')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('GitHub resource locator is incomplete')
  const repository = `/repos/${parts[0]}/${parts[1].replace(/\.git$/u, '')}`
  if (resource.kind === 'github-repository') return repository
  if (resource.kind === 'github-pr' && parts[2] === 'pull' && /^\d+$/u.test(parts[3] ?? '')) return `${repository}/pulls/${parts[3]}`
  if (resource.kind === 'github-issue' && parts[2] === 'issues' && /^\d+$/u.test(parts[3] ?? '')) return `${repository}/issues/${parts[3]}`
  throw new Error('GitHub resource locator does not match its declared kind')
}

async function fetchUrlResource(resource: ResourceReference): Promise<{ url: string; mediaType: string; content: string; truncated: boolean }> {
  const url = new URL(resource.locator)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('URL resource must use http or https')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./u.test(hostname)) throw new Error('URL resource points to a private or loopback address')
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    if (!response.ok) throw new Error(`URL resource returned HTTP ${response.status}`)
    const reader = response.body?.getReader(); if (reader === undefined) throw new Error('URL resource has no response body')
    const chunks: Uint8Array[] = []; let bytes = 0; let truncated = false
    while (true) { const next = await reader.read(); if (next.done) break; const remaining = 2 * 1024 * 1024 - bytes; if (next.value.byteLength > remaining) { chunks.push(next.value.subarray(0, remaining)); bytes += remaining; truncated = true; break } bytes += next.value.byteLength; chunks.push(next.value) }
    const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return { url: resource.locator, mediaType: response.headers.get('content-type') ?? 'application/octet-stream', content: Buffer.from(data).toString('utf8'), truncated }
  } finally { clearTimeout(timer) }
}

function registerResourceProviders(): void {
  if (resourceProvidersReady) return
  resourceProvidersReady = true
  const localProvider = async (resource: ResourceReference, operation: ResourceOperation = 'inspect', input: Record<string, unknown> = {}): Promise<unknown> => {
    const target = await validateRemoteCwd(resource.locator); const info = await stat(target)
    if (operation === 'inspect') return { resourceId: resource.resourceId, kind: resource.kind, path: target, type: info.isDirectory() ? 'folder' : 'file', bytes: info.size, modifiedAt: info.mtime.toISOString() }
    if (operation === 'read') { if (info.isDirectory()) throw new Error('cannot read a folder as a file'); return readBoundedFile(target, boundedNumber(input.offset, 0, 2 * 1024 * 1024), boundedNumber(input.limit, 2 * 1024 * 1024, 2 * 1024 * 1024)) }
    if (operation === 'tree') { if (!info.isDirectory()) throw new Error('cannot list a file as a folder'); const entries = await readdir(target, { withFileTypes: true }); return entries.slice(0, 512).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'folder' : 'file' })) }
    if (operation === 'search') { const query = typeof input.query === 'string' && input.query.length > 0 ? input.query.slice(0, 512) : undefined; if (query === undefined) throw new Error('resource search query is required'); try { const result = await execFileAsync('rg', ['--no-heading', '--line-number', '--hidden', '-g', '!.git', query, target], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }); return { matches: result.stdout.split('\n').filter(Boolean).slice(0, 500) } } catch (error) { if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('resource search requires ripgrep'); return { matches: [] } } }
    throw new Error(`operation ${operation} is not available for ${resource.kind}`)
  }
  resourceProviders.register('file', localProvider); resourceProviders.register('folder', localProvider)
  resourceProviders.register('git', async (resource, operation = 'inspect', input = {}) => {
    const target = await validateRemoteCwd(resource.locator); const presentation = new GitPresentation(target)
    if (operation === 'inspect') return presentation.summary(target)
    if (operation === 'tree') { const entries = await readdir(target, { withFileTypes: true }); return entries.filter(entry => entry.name !== '.git').slice(0, 512).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'folder' : 'file' })) }
    if (operation === 'search') { const query = typeof input.query === 'string' && input.query.length > 0 ? input.query.slice(0, 512) : undefined; if (query === undefined) throw new Error('resource search query is required'); try { const result = await execFileAsync('rg', ['--no-heading', '--line-number', '--hidden', '-g', '!.git', query, target], { cwd: target, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }); return { matches: result.stdout.split('\n').filter(Boolean).slice(0, 500) } } catch (error) { if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('resource search requires ripgrep'); return { matches: [] } } }
    if (operation === 'diff') return presentation.diff(target, typeof input.path === 'string' ? input.path : undefined)
    if (operation === 'read') { const path = typeof input.path === 'string' ? resolve(target, input.path) : undefined; if (path === undefined || !isPathInside(target, path)) throw new Error('repository read path is outside the workspace'); const realTarget = await realpath(path).catch(() => { throw new Error('repository read path does not exist') }); if (!isPathInside(target, realTarget)) throw new Error('repository read path symlink escapes the workspace'); return readBoundedFile(realTarget, boundedNumber(input.offset, 0, 2 * 1024 * 1024), boundedNumber(input.limit, 2 * 1024 * 1024, 2 * 1024 * 1024)) }
    if (operation === 'history') return (await execFileAsync('git', ['--no-pager', 'log', '-20', '--format=%h %ad %s', '--date=iso-strict'], { cwd: target, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout
    throw new Error(`operation ${operation} is not available for git resources`)
  })
  const githubProvider = async (resource: ResourceReference): Promise<unknown> => {
    const endpoint = githubEndpoint(resource)
    try { const result = await execFileAsync('gh', ['api', endpoint], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }); return JSON.parse(result.stdout) as unknown } catch (error) { throw new Error(`GitHub provider unavailable: ${error instanceof Error ? error.message : String(error)}`) }
  }
  resourceProviders.register('github-repository', githubProvider); resourceProviders.register('github-pr', githubProvider); resourceProviders.register('github-issue', githubProvider)
  resourceProviders.register('url', async (resource, operation = 'read') => { if (operation !== 'inspect' && operation !== 'read') throw new Error(`operation ${operation} is not available for URL resources`); return fetchUrlResource(resource) })
}

function parseResource(value: unknown): ResourceReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>; const kind = source.kind as ResourceReference['kind']
  if (typeof source.resourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(source.resourceId) || typeof source.label !== 'string' || source.label.trim() === '' || source.label.length > 160 || typeof source.locator !== 'string' || source.locator.length === 0 || source.locator.length > 4_096 || !resourceKinds.has(kind)) return undefined
  return { resourceId: source.resourceId, kind, label: source.label.trim(), locator: source.locator, createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString() }
}

async function readResourceReferences(): Promise<ResourceReference[]> {
  const path = join(dshpilotRoot(), 'resources.json')
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(value)) return []
    return value.slice(0, 256).flatMap(item => { const resource = parseResource(item); return resource === undefined ? [] : [resource] })
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

async function writeResourceReferences(resources: readonly ResourceReference[]): Promise<void> {
  const path = join(dshpilotRoot(), 'resources.json'); await mkdir(dshpilotRoot(), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(resources, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, path) } catch (error) { if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await rm(path, { force: true }); await rename(temporary, path) }
}

async function resourceRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  registerResourceProviders(); const resources = await readResourceReferences()
  if (request.method === 'GET') { json(response, 200, { resources, providers: resourceProviders.list() }); return }
  if (request.method !== 'POST') { json(response, 405, { error: 'method not allowed' }); return }
  const value = await body(request); const action = String(value.action ?? '')
  if (action === 'add') {
    const resource = parseResource(value.resource); if (resource === undefined) { json(response, 400, { error: 'resource is invalid' }); return }
    if (resources.some(item => item.resourceId === resource.resourceId)) { json(response, 409, { error: 'resource id already exists' }); return }
    if (resource.kind === 'file' || resource.kind === 'folder' || resource.kind === 'git') await validateRemoteCwd(resource.locator)
    const next = [...resources, resource]; await writeResourceReferences(next); json(response, 200, { resource, resources: next }); return
  }
  if (action === 'remove') { const next = resources.filter(item => item.resourceId !== String(value.resourceId ?? '')); if (next.length === resources.length) { json(response, 404, { error: 'resource was not found' }); return } await writeResourceReferences(next); json(response, 200, { resources: next }); return }
  if (action === 'resolve') { const resource = resources.find(item => item.resourceId === String(value.resourceId ?? '')); if (resource === undefined) { json(response, 404, { error: 'resource was not found' }); return } const operation = typeof value.operation === 'string' ? value.operation as ResourceOperation : 'inspect'; const input = typeof value.input === 'object' && value.input !== null && !Array.isArray(value.input) ? value.input as Record<string, unknown> : {}; json(response, 200, { resource, value: await resourceProviders.resolve(resource, operation, input) }); return }
  json(response, 400, { error: 'unsupported resource action' })
}

function createRemoteAdapter(api: HarnessApi): {
  adapter: {
    runtimeStatus: () => RuntimeStatus
    sessions: () => Promise<SessionSummary[]>
    tasks: () => Promise<TaskSummary[]>
    admitPrompt: (request: { requestId: string; sessionId?: string; input: string; mode?: 'queue' | 'steer'; cwd?: string }) => Promise<{ taskId: string }>
    interrupt: (sessionId: string) => Promise<void>
    permissions: (sessionId?: string) => Promise<PermissionSummary[]>
    questions: () => Promise<unknown[]>
    permissionReply: (permissionId: string, decision: 'allow' | 'deny') => Promise<void>
    questionReply: (rpcId: string, sessionId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>) => Promise<void>
    artifacts: () => Promise<unknown[]>
    artifactRead: (artifactId: string) => Promise<Uint8Array>
    artifactOpen: (artifactId: string) => Promise<{ opened: boolean }>
    artifactReveal: (artifactId: string) => Promise<{ opened: boolean }>
    git: (cwd: string, path?: string) => Promise<unknown>
    gitOpen: (cwd: string, path: string) => Promise<{ opened: boolean }>
    gitReveal: (cwd: string, path: string) => Promise<{ opened: boolean }>
    resources: () => Promise<unknown[]>
    resourceResolve: (resourceId: string, operation: string, input: Record<string, unknown>) => Promise<unknown>
    lineage: (sessionId: string) => Promise<unknown[]>
  }
  hydrate: () => Promise<void>
  pump: (server: ControlPlaneServer, signal: AbortSignal) => Promise<void>
} {
  type PendingPermission = { summary: PermissionSummary; rpcId: string; sessionId: string; approvalId: string }
  type PendingQuestion = { sessionId: string; rpcId: string; questions: Array<{ id: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }> }
  type RemoteProjection = { schemaVersion: 1; jobs: HarnessJob[]; permissions: PendingPermission[]; questions: PendingQuestion[]; lineage: SessionLineage[] }
  const jobs = new Map<string, HarnessJob>()
  const sessionJobs = new Map<string, Set<string>>()
  const permissions = new Map<string, PendingPermission>()
  const questions = new Map<string, PendingQuestion>()
  const artifacts = new ArtifactStore(dshHome())
  const lineage = new SessionLineageStore()
  registerResourceProviders()
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
    let discardedInteractiveState = false
    try {
      const value = JSON.parse(await readFile(projectionPath, 'utf8')) as Partial<RemoteProjection>
      if (value.schemaVersion !== 1) return
      if (Array.isArray(value.jobs)) for (const job of value.jobs) if (typeof job?.id === 'string' && typeof job.kind === 'string' && typeof job.label === 'string' && typeof job.startedAt === 'number') jobs.set(job.id, job)
      // Harness RPC ids are process-local. Persisting an approval/question as
      // actionable after a Harness restart would make the remote UI send a
      // stale response to a new process. Drop only interactive waiters and
      // rewrite the projection; durable jobs and lineage remain available.
      if (value.permissions?.some(permission => permission?.summary?.status === 'pending')) discardedInteractiveState = true
      if (value.questions?.some(question => typeof question?.rpcId === 'string')) discardedInteractiveState = true
      if (Array.isArray(value.lineage)) for (const record of value.lineage) if (typeof record?.sessionId === 'string' && typeof record?.rootSessionId === 'string' && typeof record?.createdAt === 'string') lineage.add(record)
      if (discardedInteractiveState) persistProjection()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`DSHPilot remote projection ignored: ${String(error)}`) }
  }
  const adapter = {
    runtimeStatus,
    sessions: async (): Promise<SessionSummary[]> => {
      const value = officialValue(await api.sessions.list({ rpcId: requestId(), payload: {} }))
      for (const session of value.items) lineage.add({ sessionId: session.sessionId, parentSessionId: session.parentSessionId, rootSessionId: session.parentSessionId === undefined ? session.sessionId : (lineage.lineage(session.parentSessionId)[0]?.rootSessionId ?? session.parentSessionId), createdAt: new Date(session.updatedAt).toISOString() })
      persistProjection()
      return value.items.map(session => ({ ...sessionSummary(session), status: Array.from(permissions.values()).some(item => item.sessionId === session.sessionId) || Array.from(questions.values()).some(item => item.sessionId === session.sessionId) ? 'waiting' as const : sessionSummary(session).status }))
    },
    tasks: async (): Promise<TaskSummary[]> => [...jobs.values()].map(job => ({
      taskId: job.id, ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }), status: job.status === 'running' ? 'running' : job.status === 'stopping' ? 'waiting' : job.status === 'completed' ? 'completed' : job.status === 'killed' ? 'cancelled' : 'failed',
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
    questions: async (): Promise<unknown[]> => [...questions.values()],
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
    artifactOpen: async (artifactId: string): Promise<{ opened: boolean }> => artifacts.open(artifactId),
    artifactReveal: async (artifactId: string): Promise<{ opened: boolean }> => artifacts.revealInFileManager(artifactId),
    git: async (cwd: string, path?: string): Promise<unknown> => {
      const target = await approvedGitPresentation(cwd)
      return target.git.summary(target.cwd, path)
    },
    gitOpen: async (cwd: string, path: string): Promise<{ opened: boolean }> => openApprovedPath(cwd, path, false),
    gitReveal: async (cwd: string, path: string): Promise<{ opened: boolean }> => openApprovedPath(cwd, path, true),
    resources: async (): Promise<unknown[]> => readResourceReferences(),
    resourceResolve: async (resourceId: string, operation: string, input: Record<string, unknown>): Promise<unknown> => {
      const resource = (await readResourceReferences()).find(item => item.resourceId === resourceId)
      if (resource === undefined) throw new Error('resource was not found')
      if (!['inspect', 'tree', 'search', 'read', 'diff', 'history'].includes(operation)) throw new Error('resource operation is invalid')
      return resourceProviders.resolve(resource, operation as ResourceOperation, input)
    },
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
            for (const jobId of previous) if (!current.has(jobId) && !['completed', 'failed', 'killed'].includes(jobs.get(jobId)?.status ?? '')) jobs.delete(jobId)
            for (const job of frame.jobs) {
              const before = jobs.get(job.id); jobs.set(job.id, { ...job, sessionId: frame.sessionId })
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
            const rpcId = frame.rpcId ?? envelope.rpcId; questions.set(rpcId, { sessionId: frame.sessionId, rpcId, questions: projectQuestions(frame.questions) })
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
  const allowedHosts = (process.env.DSHPILOT_REMOTE_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const eventsPath = join(dshpilotRoot(), 'control-events.jsonl')
  const devicesPath = join(dshpilotRoot(), 'devices.json')
  const relayUrl = process.env.DSHPILOT_REMOTE_RELAY_URL
  const relayToken = process.env.DSHPILOT_REMOTE_RELAY_TOKEN
  const relayChannel = process.env.DSHPILOT_REMOTE_RELAY_CHANNEL
  const relayEncryptionKey = process.env.DSHPILOT_REMOTE_RELAY_KEY
  const relayValues = [relayUrl, relayToken, relayChannel, relayEncryptionKey]
  const relayConfigured = relayValues.every(value => value !== undefined)
  const bridge = createRemoteAdapter(ctx.apiProxy)
  const abort = new AbortController()
  let server: ControlPlaneServer | undefined
  let relayTunnel: RestrictedRelayTunnel | undefined
  let started = false
  let disposed = false
  const start = async (): Promise<void> => {
    const [{ readFile: read }, { mkdir: makeDir }] = await Promise.all([import('node:fs/promises'), import('node:fs/promises')])
    await makeDir(dshpilotRoot(), { recursive: true, mode: 0o700 })
    const tls = tlsKeyPath !== undefined && tlsCertPath !== undefined ? { key: await read(resolve(tlsKeyPath)), cert: await read(resolve(tlsCertPath)) } : undefined
    if (relayValues.some(value => value !== undefined) && !relayConfigured) throw new Error('DSHPILOT_REMOTE_RELAY_URL, _TOKEN, _CHANNEL, and _KEY must be configured together')
    await bridge.hydrate()
    server = new ControlPlaneServer({ name: 'DSHPilot self-hosted Harness control plane', version: '0.1.0', host, port, remoteEnabled: true, tls, corsOrigins, allowedHosts, eventsPath, devicesPath, relayEnabled: true, allowLocalPairingOffer: process.env.DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING === '1' || relayConfigured, allowLocalAdminPairing: process.env.DSHPILOT_REMOTE_ALLOW_LOCAL_ADMIN === '1', authorization: async context => {
      if (context.cwd !== undefined && context.cwd !== '') await validateRemoteCwd(context.cwd)
      if (context.sessionId !== undefined) { const sessions = await bridge.adapter.sessions(); if (!sessions.some(session => session.sessionId === context.sessionId)) return { allowed: false, code: 'SESSION_NOT_FOUND', message: 'session is not owned by this Harness instance' } }
      if (context.artifactId !== undefined) { const artifacts = await bridge.adapter.artifacts(); if (!artifacts.some(item => typeof item === 'object' && item !== null && (item as { artifactId?: unknown }).artifactId === context.artifactId)) return { allowed: false, code: 'ARTIFACT_NOT_FOUND', message: 'artifact is not owned by this Harness instance' } }
      if (context.resourceId !== undefined) { const resources = await bridge.adapter.resources(); if (!resources.some(item => typeof item === 'object' && item !== null && (item as { resourceId?: unknown }).resourceId === context.resourceId)) return { allowed: false, code: 'RESOURCE_NOT_FOUND', message: 'resource is not owned by this Harness instance' } }
      const request = context.request
      if (request?.kind === 'permission_reply') { const permissions = await bridge.adapter.permissions(); if (!permissions.some(permission => permission.permissionId === request.permissionId && permission.status === 'pending')) return { allowed: false, code: 'PERMISSION_NOT_FOUND', message: 'permission is no longer pending' } }
      if (request?.kind === 'question_reply') { const questions = await bridge.adapter.questions(); if (!questions.some(item => typeof item === 'object' && item !== null && (item as { rpcId?: unknown }).rpcId === request.rpcId)) return { allowed: false, code: 'QUESTION_NOT_FOUND', message: 'question is no longer pending' } }
      return true
    }, adapter: bridge.adapter })
    const address = await server.start()
    if (disposed) { await server.stop(); return }
    started = true
    console.log(JSON.stringify({ dshpilotRemote: 'ready', ...address, remoteEnabled: true, tls: tls !== undefined }))
    if (relayConfigured) {
      relayTunnel = new RestrictedRelayTunnel({ relayUrl: relayUrl!, token: relayToken!, encryptionKey: relayEncryptionKey!, channelId: relayChannel!, localBaseUrl: process.env.DSHPILOT_REMOTE_RELAY_LOCAL_URL ?? `http://${address.host}:${address.port}` })
      relayTunnel.start()
      console.log(JSON.stringify({ dshpilotRelayTunnel: 'ready', relayUrl, channelId: relayChannel }))
    }
    if (process.env.DSHPILOT_REMOTE_PRINT_PAIRING === '1') console.log(JSON.stringify({ dshpilotPairingOffer: server.devices.createOffer() }))
    void bridge.pump(server, abort.signal).catch(error => { if (!abort.signal.aborted) console.error(`DSHPilot remote event bridge stopped: ${String(error)}`) })
  }
  void start().catch(error => console.error(`DSHPilot remote control failed: ${String(error)}`))
  ctx.effect?.(() => () => {
    disposed = true
    abort.abort()
    relayTunnel?.stop()
    if (started && server !== undefined) void server.stop()
  }, 'dshpilot.remote-control')
}

/**
 * Host-side loading sentinel. OS integration remains in Tauri; this plugin is
 * intentionally a small Cordis seam that can be loaded by a Harness profile
 * without introducing a second session or MCP implementation.
 */
export async function apply(ctx: DesktopHostPluginContext): Promise<void> {
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
      resourceTools: ['resource_inspect', 'resource_tree', 'resource_search', 'resource_read', 'resource_diff', 'resource_history'],
      registeredToolSchemas: ctx.tools?.schemas?.().length ?? undefined,
    })
  }}),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/mcp', handler: (request, response) => mcpRoute(request, response, ctx) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/documents', handler: (request, response) => documentRoute(request, response) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/resources', handler: (request, response) => resourceRoute(request, response) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/tokens', handler: (request, response) => tokenRoute(request, response, ctx) }),
  ctx.webServer?.register({ kind: 'exact', path: '/__dshpilot/notifications', handler: (request, response) => notificationRoute(request, response) }),
  ].filter((value): value is () => void => value !== undefined)
  ctx.effect?.(() => () => { for (const dispose of disposers) dispose() }, 'dshpilot.desktop.routes')
  const disposeDocumentTools = registerDocumentTools(ctx)
  ctx.effect?.(() => disposeDocumentTools, 'dshpilot.document-tools')
  const disposeResourceTools = registerResourceTools(ctx)
  ctx.effect?.(() => disposeResourceTools, 'dshpilot.resource-tools')
  if (ctx.loader !== undefined) {
    const records = await new McpManager(dshHome()).list()
    await reconcileMcpLoader(ctx, records)
  }
  startRemoteControl(ctx)
}

export default { name, inject, apply }
