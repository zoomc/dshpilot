import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'
export type McpTransport = 'stdio' | 'streamable-http'
export type McpRecordStatus = 'configured' | 'disabled' | 'connecting' | 'ready' | 'reconnecting' | 'failed'

export interface McpServerRecord {
  id: string
  serverName: string
  transport: McpTransport
  enabled: boolean
  status: McpRecordStatus
  command?: string
  args: string[]
  cwd?: string
  url?: string
  env: Record<string, string>
  envRefs: Record<string, string>
  headers: Record<string, string>
  headerRefs: Record<string, string>
  toolCount?: number
  lastError?: string
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  updatedAt: string
}

export interface McpDiff {
  added: string[]
  changed: string[]
  unchanged: string[]
}

export interface McpImportPreview {
  source: string
  format: 'claude' | 'cursor' | 'generic'
  servers: McpServerRecord[]
  diff: McpDiff
  warnings: string[]
}

export interface McpImportResult {
  preview: McpImportPreview
  applied: boolean
  records: McpServerRecord[]
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
const ID_NAME = /^[A-Za-z0-9._-]{1,80}$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const SECRET_KEY = /(token|secret|password|api[-_]?key|authorization|credential)/iu

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function normalizeId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)
  if (normalized.length === 0) throw new Error('MCP server id must contain a letter or number')
  return normalized
}

function stableId(value: string): string {
  const base = normalizeId(value)
  return ID_NAME.test(base) ? base : createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function environmentReference(value: string): string | undefined {
  const match = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u)
  return match?.[1]
}

function safeSecretMap(
  value: unknown,
  keyLabel: string,
  warnings: string[],
): { values: Record<string, string>; refs: Record<string, string> } {
  const values: Record<string, string> = {}
  const refs: Record<string, string> = {}
  for (const [key, raw] of Object.entries(object(value))) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const ref = environmentReference(raw)
    if (SECRET_KEY.test(key) || keyLabel === 'headers' && key.toLowerCase() === 'authorization') {
      if (ref !== undefined && ENV_NAME.test(ref)) refs[key] = ref
      else warnings.push(`${keyLabel}.${key}: secret value omitted; use an environment reference like $${key}`)
    } else {
      values[key] = raw
    }
  }
  return { values, refs }
}

function toRecord(idHint: string, raw: unknown, warnings: string[]): McpServerRecord {
  const input = object(raw)
  const serverName = String(input.serverName ?? input.name ?? idHint).trim()
  if (!SERVER_NAME.test(serverName)) throw new Error(`invalid MCP serverName "${serverName}"`)
  const transportValue = String(input.transport ?? (input.url !== undefined ? 'streamable-http' : 'stdio'))
  const transport: McpTransport = transportValue === 'sse' || transportValue === 'http' || transportValue === 'streamable-http'
    ? 'streamable-http' : 'stdio'
  const id = stableId(String(input.id ?? idHint ?? serverName))
  const secretEnv = safeSecretMap(input.env, 'env', warnings)
  const secretHeaders = safeSecretMap(input.headers, 'headers', warnings)
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === 'string') : []
  if (transport === 'stdio' && typeof input.command !== 'string') throw new Error(`${id}: stdio MCP server requires command`)
  if (transport === 'streamable-http' && typeof input.url !== 'string') throw new Error(`${id}: HTTP MCP server requires url`)
  return {
    id, serverName, transport, enabled: input.enabled !== false && input.disabled !== true,
    status: input.enabled === false || input.disabled === true ? 'disabled' : 'configured',
    ...(transport === 'stdio' ? { command: input.command as string } : { url: input.url as string }),
    args,
    ...(typeof input.cwd === 'string' && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    env: secretEnv.values,
    envRefs: secretEnv.refs,
    headers: secretHeaders.values,
    headerRefs: secretHeaders.refs,
    ...(Number.isSafeInteger(input.toolCallTimeoutMs) ? { toolCallTimeoutMs: input.toolCallTimeoutMs as number } : {}),
    ...(typeof input.failOnStartupError === 'boolean' ? { failOnStartupError: input.failOnStartupError } : {}),
    updatedAt: new Date().toISOString(),
  }
}

function comparable(record: McpServerRecord): string {
  const { status: _status, updatedAt: _updatedAt, ...stable } = record
  return JSON.stringify(stable)
}

export function validateMcpServer(record: McpServerRecord): McpServerRecord {
  if (!ID_NAME.test(record.id)) throw new Error('MCP server id is invalid')
  if (!SERVER_NAME.test(record.serverName)) throw new Error('MCP serverName is invalid')
  if (record.transport === 'stdio' && (!record.command || record.url !== undefined)) throw new Error(`${record.id}: invalid stdio config`)
  if (record.transport === 'streamable-http' && (!record.url || record.command !== undefined)) throw new Error(`${record.id}: invalid HTTP config`)
  if (!Array.isArray(record.args) || record.args.some(item => typeof item !== 'string')) throw new Error(`${record.id}: args must be strings`)
  for (const key of Object.keys(record.envRefs)) if (!ENV_NAME.test(record.envRefs[key] ?? '')) throw new Error(`${record.id}: invalid environment reference`)
  return record
}

export function diffMcpServers(existing: readonly McpServerRecord[], incoming: readonly McpServerRecord[]): McpDiff {
  const old = new Map(existing.map(item => [item.id, item]))
  const added: string[] = []
  const changed: string[] = []
  const unchanged: string[] = []
  for (const record of incoming) {
    const before = old.get(record.id)
    if (before === undefined) added.push(record.id)
    else if (comparable(before) !== comparable(record)) changed.push(record.id)
    else unchanged.push(record.id)
  }
  return { added, changed, unchanged }
}

export interface McpRuntimeStatus {
  status: Exclude<McpRecordStatus, 'configured'>
  toolCount?: number
  lastError?: string
}

export function parseMcpImport(text: string, source = 'import.json', existing: readonly McpServerRecord[] = []): McpImportPreview {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(`${source}: only JSON MCP imports are accepted in Phase 2`) }
  const root = object(parsed)
  const rawServers = root.mcpServers ?? root.servers ?? (Array.isArray(parsed) ? parsed : undefined)
  const format: McpImportPreview['format'] = root.mcpServers !== undefined
    ? (source.toLowerCase().includes('cursor') ? 'cursor' : 'claude') : 'generic'
  const entries: Array<[string, unknown]> = Array.isArray(rawServers)
    ? rawServers.map((item, index) => [String(index + 1), item])
    : Object.entries(object(rawServers))
  if (entries.length === 0) throw new Error(`${source}: no mcpServers or servers entries found`)
  const warnings: string[] = []
  const servers = entries.map(([key, value]) => toRecord(key, value, warnings)).map(validateMcpServer)
  return { source, format, servers, diff: diffMcpServers(existing, servers), warnings }
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function renderMap(entries: Record<string, string>, refs: Record<string, string>, indent: string): string[] {
  const rows: string[] = []
  for (const [key, value] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) rows.push(`${indent}${yamlString(key)}: ${yamlString(value)}`)
  for (const [key, value] of Object.entries(refs).sort(([left], [right]) => left.localeCompare(right))) rows.push(`${indent}${yamlString(key)}: !!js process.env.${value}`)
  return rows
}

export function renderMcpPatch(records: readonly McpServerRecord[]): string {
  const lines = ['# Generated by DSHPilot. Secrets are environment references only.', '']
  for (const record of records) {
    lines.push('- insert:', `    - id: ${yamlString(record.id)}`, `      name: ${yamlString(MCP_PLUGIN_NAME)}`, `      disabled: ${String(!record.enabled)}`, '      config:', `        serverName: ${yamlString(record.serverName)}`, `        transport: ${yamlString(record.transport)}`)
    if (record.transport === 'stdio') {
      lines.push(`        command: ${yamlString(record.command ?? '')}`)
      lines.push(`        args: ${JSON.stringify(record.args)}`)
      if (record.cwd !== undefined) lines.push(`        cwd: ${yamlString(record.cwd)}`)
    } else {
      lines.push(`        url: ${yamlString(record.url ?? '')}`)
    }
    if (Object.keys(record.env).length > 0 || Object.keys(record.envRefs).length > 0) {
      lines.push('        env:', ...renderMap(record.env, record.envRefs, '          '))
    }
    if (Object.keys(record.headers).length > 0 || Object.keys(record.headerRefs).length > 0) {
      lines.push('        headers:', ...renderMap(record.headers, record.headerRefs, '          '))
    }
    if (record.toolCallTimeoutMs !== undefined) lines.push(`        toolCallTimeoutMs: ${record.toolCallTimeoutMs}`)
    if (record.failOnStartupError !== undefined) lines.push(`        failOnStartupError: ${String(record.failOnStartupError)}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

export class McpManager {
  readonly root: string
  readonly statePath: string
  readonly patchPath: string

  constructor(dshHome: string) {
    this.root = resolve(join(dshHome, 'dshpilot'))
    this.statePath = join(this.root, 'mcp-servers.json')
    this.patchPath = join(this.root, 'mcp.patch.yml')
  }

  async list(): Promise<McpServerRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown
      if (!Array.isArray(value)) throw new Error('MCP state must be an array')
      return value.map(item => validateMcpServer(item as McpServerRecord))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async save(records: readonly McpServerRecord[]): Promise<void> {
    const normalized = records.map(validateMcpServer)
    await atomicWrite(this.statePath, `${JSON.stringify(normalized, null, 2)}\n`)
    await atomicWrite(this.patchPath, renderMcpPatch(normalized))
  }

  async upsert(record: McpServerRecord): Promise<McpServerRecord[]> {
    const next = validateMcpServer({ ...record, updatedAt: new Date().toISOString() })
    const records = await this.list()
    const index = records.findIndex(item => item.id === next.id)
    if (index === -1) records.push(next)
    else records[index] = next
    await this.save(records)
    return records
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerRecord[]> {
    const records = await this.list()
    const record = records.find(item => item.id === id)
    if (record === undefined) throw new Error(`unknown MCP server: ${id}`)
    record.enabled = enabled
    record.status = enabled ? 'configured' : 'disabled'
    record.updatedAt = new Date().toISOString()
    await this.save(records)
    return records
  }

  async updateRuntimeStatus(id: string, update: McpRuntimeStatus): Promise<McpServerRecord[]> {
    const records = await this.list()
    const record = records.find(item => item.id === id)
    if (record === undefined) throw new Error(`unknown MCP server: ${id}`)
    record.status = update.status
    record.toolCount = update.toolCount
    record.lastError = update.lastError
    record.updatedAt = new Date().toISOString()
    await this.save(records)
    return records
  }

  async remove(id: string): Promise<McpServerRecord[]> {
    const records = await this.list()
    const next = records.filter(item => item.id !== id)
    if (next.length === records.length) throw new Error(`unknown MCP server: ${id}`)
    await this.save(next)
    return next
  }

  async import(preview: McpImportPreview, confirm: boolean): Promise<McpImportResult> {
    if (!confirm) return { preview, applied: false, records: await this.list() }
    const records = await this.list()
    const byId = new Map(records.map(item => [item.id, item]))
    for (const item of preview.servers) byId.set(item.id, item)
    const next = [...byId.values()]
    await this.save(next)
    return { preview, applied: true, records: next }
  }
}
