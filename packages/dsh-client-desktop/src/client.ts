import { createElement, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'

export const name = 'dshpilot-client'
export const inject = ['slots'] as const

interface HealthSnapshot { status: string; runtimeVersion: string; harnessVersion: string; webUiReady: boolean; apiReady: boolean }
interface McpRecord { id: string; serverName: string; transport: string; enabled: boolean; status: string; toolCount?: number; lastError?: string }
interface DocumentManifest { attachmentId: string; name: string; kind: string; bytes: number; createdAt: string }
interface TokenSnapshot { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; projectedTokens?: number; contextWindow?: number; systemTokens?: number; toolsTokens?: number; messageTokens?: number; source: 'official' | 'estimate'; estimate: boolean }; note?: string }
interface RuntimeUpdateInfo { available: boolean; current_version?: string; candidate_version: string; candidate_upstream_sha?: string; manifest_url: string; checked_at: string }
interface SessionActivity { runningCount: number }

type UpdateCandidate =
  | { kind: 'runtime'; runtime: RuntimeUpdateInfo }
  | { kind: 'app'; update: Update }

interface SidebarFooterActionProps { wide?: boolean }

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function postJson<T>(path: string, value: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
  return result
}

function DshPilotStatusPanel(): ReturnType<typeof createElement> {
  const [health, setHealth] = useState<HealthSnapshot | undefined>()
  const [tab, setTab] = useState<'overview' | 'mcp' | 'documents' | 'tokens'>('overview')
  const [mcp, setMcp] = useState<McpRecord[]>([])
  const [documents, setDocuments] = useState<DocumentManifest[]>([])
  const [tokens, setTokens] = useState<TokenSnapshot | undefined>()
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [error, setError] = useState<string | undefined>()
  const refreshData = (): void => {
    void Promise.all([
      getJson<{ records: McpRecord[] }>('/__dshpilot/mcp').then(value => setMcp(value.records)),
      getJson<{ manifests: DocumentManifest[] }>('/__dshpilot/documents').then(value => setDocuments(value.manifests)),
      getJson<TokenSnapshot>(`/__dshpilot/tokens${selectedSessionId === '' ? '' : `?sessionId=${encodeURIComponent(selectedSessionId)}`}`).then(setTokens),
    ]).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  useEffect(() => {
    let cancelled = false
    const read = (): void => { void fetch('/__dshpilot/health').then(response => response.json() as Promise<HealthSnapshot>).then(value => { if (!cancelled) setHealth(value) }).catch(() => { if (!cancelled) setHealth(undefined) }) }
    read(); refreshData(); const timer = window.setInterval(() => { read(); refreshData() }, 5_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (selectedSessionId === '') return
    void getJson<TokenSnapshot>(`/__dshpilot/tokens?sessionId=${encodeURIComponent(selectedSessionId)}`).then(setTokens).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }, [selectedSessionId])
  const toggleMcp = (record: McpRecord): void => { void postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'toggle', id: record.id, enabled: !record.enabled }).then(value => setMcp(value.records)).catch(value => setError(String(value))) }
  const restartMcp = (record: McpRecord): void => { void postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'restart', id: record.id }).then(value => setMcp(value.records)).catch(value => setError(String(value))) }
  const removeMcp = (record: McpRecord): void => { if (!window.confirm(`Remove MCP server ${record.serverName}?`)) return; void postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'remove', id: record.id }).then(value => setMcp(value.records)).catch(value => setError(String(value))) }
  const editMcp = (record?: McpRecord): void => {
    const text = window.prompt(record === undefined ? 'Paste a complete MCP server JSON record:' : 'Edit the complete MCP server JSON record:', record === undefined ? JSON.stringify({ id: 'new-server', serverName: 'new_server', transport: 'stdio', enabled: true, status: 'configured', command: '', args: [], env: {}, envRefs: {}, headers: {}, headerRefs: {}, updatedAt: new Date().toISOString() }, null, 2) : JSON.stringify(record, null, 2))
    if (text === null || text.trim() === '') return
    try { const recordValue = JSON.parse(text) as McpRecord; void postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'upsert', record: recordValue }).then(value => setMcp(value.records)).catch(value => setError(String(value))) } catch (value) { setError(value instanceof Error ? value.message : String(value)) }
  }
  const importMcp = (): void => {
    const text = window.prompt('Paste an MCP JSON configuration for preview and diff:')
    if (text === null || text.trim() === '') return
    const source = window.prompt('Import source filename (include cursor for Cursor format):', 'desktop-import.json') ?? 'desktop-import.json'
    void postJson<{ preview: { diff: { added: string[]; changed: string[]; unchanged: string[] }; warnings: string[] }; records: McpRecord[] }>('/__dshpilot/mcp', { action: 'preview-import', source, text }).then(preview => {
      const summary = `Added: ${preview.preview.diff.added.length}; changed: ${preview.preview.diff.changed.length}; unchanged: ${preview.preview.diff.unchanged.length}${preview.preview.warnings.length === 0 ? '' : `\nWarnings: ${preview.preview.warnings.join('; ')}`}`
      if (!window.confirm(`${summary}\nApply this import?`)) return undefined
      return postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'apply-import', preview: preview.preview, confirm: true }).then(value => setMcp(value.records))
    }).catch(value => setError(String(value)))
  }
  const addDocument = (): void => { const path = window.prompt('Local document path (the Desktop Host will validate and copy it):'); if (path !== null && path.trim() !== '') void postJson<{ manifest: DocumentManifest }>('/__dshpilot/documents', { action: 'add-path', path }).then(value => setDocuments(current => [value.manifest, ...current])).catch(value => setError(String(value))) }
  const inspectDocument = (document: DocumentManifest): void => { void postJson<unknown>('/__dshpilot/documents', { action: 'inspect', attachmentId: document.attachmentId }).then(value => window.alert(JSON.stringify(value, null, 2))).catch(value => setError(String(value))) }
  const content = tab === 'mcp'
    ? createElement('div', null, createElement('strong', null, `MCP servers (${mcp.length})`), createElement('button', { type: 'button', onClick: () => editMcp() }, 'Add server'), createElement('button', { type: 'button', onClick: importMcp }, 'Preview/import JSON'), ...mcp.map(record => createElement('div', { key: record.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, createElement('span', null, `${record.serverName} · ${record.status}${record.toolCount === undefined ? '' : ` · ${record.toolCount} tools`}${record.lastError === undefined ? '' : ` · ${record.lastError}`}`), createElement('button', { type: 'button', onClick: () => editMcp(record) }, 'Edit'), createElement('button', { type: 'button', onClick: () => restartMcp(record) }, 'Restart'), createElement('button', { type: 'button', onClick: () => toggleMcp(record) }, record.enabled ? 'Disable' : 'Enable'), createElement('button', { type: 'button', onClick: () => removeMcp(record) }, 'Remove'))))
    : tab === 'documents'
      ? createElement('div', null, createElement('strong', null, `Documents (${documents.length})`), createElement('button', { type: 'button', onClick: addDocument }, 'Add local file'), ...documents.map(document => createElement('div', { key: document.attachmentId }, `${document.name} · ${document.kind} · ${document.bytes} bytes`, createElement('button', { type: 'button', onClick: () => inspectDocument(document) }, 'Inspect'))))
      : tab === 'tokens'
        ? createElement('div', null, createElement('strong', null, 'Context / Token Inspector'), createElement('div', null, `Input: ${tokens?.usage.inputTokens ?? '—'} · Output: ${tokens?.usage.outputTokens ?? '—'}`), createElement('div', null, `Total: ${tokens?.usage.totalTokens ?? '—'} · Cache read: ${tokens?.usage.cacheReadTokens ?? tokens?.usage.cachedTokens ?? '—'}`), createElement('div', null, `Context window: ${tokens?.usage.contextWindow ?? '—'} · next prompt: ${tokens?.usage.projectedTokens ?? '—'}`), createElement('div', null, `Breakdown: system ${tokens?.usage.systemTokens ?? '—'} · tools ${tokens?.usage.toolsTokens ?? '—'} · conversation ${tokens?.usage.messageTokens ?? '—'}`), createElement('small', null, `${tokens?.usage.source ?? 'estimate'}${tokens?.note === undefined ? '' : ` · ${tokens.note}`}`))
        : createElement('div', null, createElement('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, 'DSHPilot'), createElement('span', null, health?.status === 'ready' ? 'Harness ready' : 'Checking Harness…'), createElement('span', null, `Runtime: ${health?.runtimeVersion ?? 'unknown'}`), createElement('span', null, `Harness: ${health?.harnessVersion ?? 'unknown'}`))
  return createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    'data-dshpilot-status': 'true',
  },
  createElement('nav', { style: { display: 'flex', gap: 4 } }, ...(['overview', 'mcp', 'documents', 'tokens'] as const).map(value => createElement('button', { key: value, type: 'button', onClick: () => setTab(value) }, value))),
  content,
  error === undefined ? null : createElement('small', { style: { color: 'crimson' } }, error))
}

function RuntimeUpdateAction({ wide = true }: SidebarFooterActionProps): ReactNode {
  const [candidate, setCandidate] = useState<UpdateCandidate | undefined>()
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  const refresh = async (): Promise<void> => {
    setChecking(true)
    let next: UpdateCandidate | undefined
    try {
      const runtime = await invoke<RuntimeUpdateInfo>('runtime_check_update', {})
      if (runtime.available) next = { kind: 'runtime', runtime }
    } catch { /* Runtime update checks are best effort while the Harness is booting. */ }
    try {
      const app = await check()
      if (app !== null) next = { kind: 'app', update: app }
    } catch { /* App updater is unavailable in development or without a signed channel. */ }
    setCandidate(next)
    setChecking(false)
  }

  useEffect(() => {
    let cancelled = false
    void refresh().catch(() => undefined)
    const timer = window.setInterval(() => { if (!cancelled) void refresh().catch(() => undefined) }, 15 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const install = async (): Promise<void> => {
    if (candidate === undefined || busy) return
    let activity: SessionActivity
    try { activity = await getJson<SessionActivity>('/__dshpilot/sessions') } catch (error) { setMessage(`无法确认当前 session 状态，已取消更新：${error instanceof Error ? error.message : String(error)}`); return }
    if (activity.runningCount > 0 && !window.confirm(`当前有 ${activity.runningCount} 个运行中的 session。更新会停止 Harness 并重启，是否继续？`)) return
    setBusy(true)
    setMessage(undefined)
    try {
      if (candidate.kind === 'app') {
        await invoke('stop_harness')
        try {
          await candidate.update.downloadAndInstall()
          setMessage('应用更新已安装，正在重启 DSHPilot…')
        } catch (error) {
          await invoke('supervisor_restart').catch(() => undefined)
          throw error
        }
      } else {
        await invoke('runtime_update_from_url', { manifestUrl: candidate.runtime.manifest_url, allowUnsignedLocal: false })
        const url = await invoke<string>('harness_url')
        setMessage(`Runtime ${candidate.runtime.candidate_version} 已安装，Harness 正在重启…`)
        window.location.replace(url)
      }
      setCandidate(undefined)
    } catch (error) {
      setMessage(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (candidate === undefined && message === undefined) return null
  const label = busy ? '更新中…' : candidate?.kind === 'app' ? '应用更新' : 'Runtime 更新'
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px', maxWidth: wide ? 220 : 48 } },
    candidate === undefined ? null : createElement('button', {
      type: 'button', onClick: () => { void install() }, disabled: busy || checking,
      title: `${label} available`, 'aria-label': label,
      style: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent)', borderRadius: 8, padding: '6px 8px', cursor: busy ? 'wait' : 'pointer', background: 'color-mix(in srgb, #4d83ff 18%, transparent)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
    }, wide ? `↻ ${label}` : '↻'),
    message === undefined ? null : createElement('small', { style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'normal' } }, message))
}

export function apply(ctx: { slots: { inject(key: string, setup: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): () => void } }): void {
  // The status/token surface belongs to the conversation composer context.
  // Keep registration behind the official inject seam so Cordis owns its
  // lifetime and removes it during HMR/unload.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'dshpilot-status', order: 200, label: 'DSHPilot' }, DshPilotStatusPanel))
  // The official sidebar footer is the additive lower-left action seam. It
  // survives navigation because it is mounted by the Harness Web UI itself.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dshpilot-update', order: 50, label: 'DSHPilot Update' }, RuntimeUpdateAction))
}

/** The official Cordis client-plugin surface (name + inject + apply). Exported
 *  both as the default and here so any loader — ESM import or the Harness web
 *  shell's `window.__ModuleLoader__` closure-factory sink — gets the same
 *  stable object reference. */
export const plugin = { name, inject, apply }
export default plugin

/**
 * Official packaged-plugin handoff: when the bundle runs inside the Harness
 * web shell, register the surface through the page's `__ModuleLoader__` sink
 * (the contract the Cordis client runner reads). Guarded so the same module
 * still loads as a plain ESM in Node (smoke/test) without touching `window`.
 */
declare global {
  interface Window {
    __ModuleLoader__?: { load(handoff: { id: string; factory: () => unknown }): void }
  }
}
if (typeof window !== 'undefined' && typeof window.__ModuleLoader__ === 'object' && window.__ModuleLoader__ !== null) {
  window.__ModuleLoader__.load({ id: '@dshpilot/dsh-client-desktop', factory: () => plugin })
}
