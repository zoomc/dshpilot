import { createElement, useEffect, useState, type ReactNode, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const name = 'dshpilot-client'
export const inject = ['slots'] as const

interface HealthSnapshot { status: string; runtimeVersion: string; harnessVersion: string; webUiReady: boolean; apiReady: boolean }
interface McpRecord { id: string; serverName: string; transport: string; enabled: boolean; status: string; toolCount?: number; lastError?: string }
interface DocumentManifest { attachmentId: string; name: string; kind: string; bytes: number; createdAt: string }
interface TokenSnapshot { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; projectedTokens?: number; contextWindow?: number; systemTokens?: number; toolsTokens?: number; messageTokens?: number; source: 'official' | 'estimate'; estimate: boolean }; note?: string }
interface AppUpdateCheck { available: boolean; current_version: string; latest_version: string; notes: string; asset_url: string | null; asset_name: string | null; error: string | null }
interface DshCoreUpdateCheck { available: boolean; ready: boolean; local_sha: string; upstream_sha: string; published_sha: string | null; upstream_version: string | null; notes: string; error: string | null }
interface SessionActivity { runningCount: number }

const RUNTIME_MANIFEST_URL = ((): string => {
  const windows = /Windows/u.test(navigator.userAgent)
  const suffix = windows ? 'windows-x64' : 'darwin-arm64'
  return `https://github.com/zoomc/dshpilot/releases/download/runtime/current-${suffix}.json`
})()

const UPDATE_BTN: CSSProperties = { alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 8, border: '1px solid #4d83ff', background: '#4d83ff', color: '#fff', cursor: 'pointer' }

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

/** Standalone MCP server manager. Rendered both inside the conversation
 *  composer dock (the `mcp` sub-tab) and as a dedicated harness Settings
 *  top-level "MCP 管理" section (per user request). Self-contained: owns
 *  its own fetch + 5s polling so it works in either surface. */
function McpManager(): ReactNode {
  const [mcp, setMcp] = useState<McpRecord[]>([])
  const [error, setError] = useState<string | undefined>()
  const refresh = (): void => {
    void getJson<{ records: McpRecord[] }>('/__dshpilot/mcp').then(value => setMcp(value.records)).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  useEffect(() => {
    let cancelled = false
    const run = (): void => { if (!cancelled) refresh() }
    run(); const timer = window.setInterval(run, 5_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
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
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      createElement('strong', null, `MCP servers (${mcp.length})`),
      createElement('button', { type: 'button', onClick: () => editMcp() }, 'Add server'),
      createElement('button', { type: 'button', onClick: importMcp }, 'Preview/import JSON')),
    ...mcp.map(record => createElement('div', { key: record.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
      createElement('span', null, `${record.serverName} · ${record.status}${record.toolCount === undefined ? '' : ` · ${record.toolCount} tools`}${record.lastError === undefined ? '' : ` · ${record.lastError}`}`),
      createElement('span', { style: { display: 'flex', gap: 4 } },
        createElement('button', { type: 'button', onClick: () => editMcp(record) }, 'Edit'),
        createElement('button', { type: 'button', onClick: () => restartMcp(record) }, 'Restart'),
        createElement('button', { type: 'button', onClick: () => toggleMcp(record) }, record.enabled ? 'Disable' : 'Enable'),
        createElement('button', { type: 'button', onClick: () => removeMcp(record) }, 'Remove')))),
    error === undefined ? null : createElement('small', { style: { color: 'crimson' } }, error))
}

function DshPilotStatusPanel(): ReturnType<typeof createElement> {
  const [health, setHealth] = useState<HealthSnapshot | undefined>()
  const [tab, setTab] = useState<'overview' | 'mcp' | 'documents' | 'tokens'>('overview')
  const [documents, setDocuments] = useState<DocumentManifest[]>([])
  const [tokens, setTokens] = useState<TokenSnapshot | undefined>()
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [error, setError] = useState<string | undefined>()
  const refreshData = (): void => {
    void Promise.all([
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
  const addDocument = (): void => { const path = window.prompt('Local document path (the Desktop Host will validate and copy it):'); if (path !== null && path.trim() !== '') void postJson<{ manifest: DocumentManifest }>('/__dshpilot/documents', { action: 'add-path', path }).then(value => setDocuments(current => [value.manifest, ...current])).catch(value => setError(String(value))) }
  const inspectDocument = (document: DocumentManifest): void => { void postJson<unknown>('/__dshpilot/documents', { action: 'inspect', attachmentId: document.attachmentId }).then(value => window.alert(JSON.stringify(value, null, 2))).catch(value => setError(String(value))) }
  const content = tab === 'mcp'
    ? createElement(McpManager)
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
  const [appAvailable, setAppAvailable] = useState(false)
  const [coreAvailable, setCoreAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  const refresh = async (): Promise<void> => {
    let app = false
    let core = false
    try { const r = await invoke<AppUpdateCheck>('check_app_update'); app = r.available && r.asset_url !== null } catch { /* best effort */ }
    try { const r = await invoke<DshCoreUpdateCheck>('check_dsh_core_update'); core = r.available && r.ready } catch { /* best effort */ }
    setAppAvailable(app); setCoreAvailable(core)
  }

  useEffect(() => {
    let cancelled = false
    void refresh().catch(() => undefined)
    const timer = window.setInterval(() => { if (!cancelled) void refresh().catch(() => undefined) }, 24 * 60 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  if (!appAvailable && !coreAvailable && message === undefined) return null
  const label = busy ? '更新中…' : appAvailable ? 'App 更新' : 'dsh 核心更新'
  const onClick = async (): Promise<void> => {
    if (appAvailable) {
      try {
        const r = await invoke<AppUpdateCheck>('check_app_update')
        if (r.asset_url) { await installAppUpdateSafely(r.asset_url, setBusy, setMessage); return }
      } catch { /* fall through to core */ }
    }
    await installCoreUpdateSafely(setBusy, setMessage)
  }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px', maxWidth: wide ? 220 : 48 } },
    createElement('button', {
      type: 'button', onClick, disabled: busy,
      title: '更新可用', 'aria-label': label,
      style: { border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent)', borderRadius: 8, padding: '6px 8px', cursor: busy ? 'wait' : 'pointer', background: 'color-mix(in srgb, #4d83ff 18%, transparent)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
    }, wide ? `↻ ${label}` : '↻'),
    message === undefined ? null : createElement('small', { style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'normal' } }, message))
}

/** Shared install routine for both the sidebar footer action and the
 *  Settings → 检查更新 section. Confirms against running sessions, then
 *  installs either the app (Tauri updater) or the Runtime (manifest pull). */
async function hasRunningSessions(): Promise<boolean> {
  try { const activity = await getJson<SessionActivity>('/__dshpilot/sessions'); return activity.runningCount > 0 } catch { return false }
}

async function installAppUpdateSafely(assetUrl: string, setBusy: (value: boolean) => void, setMessage: (value: string | undefined) => void): Promise<void> {
  if (await hasRunningSessions() && !window.confirm('当前有运行中的 session。更新会停止 Harness 并重启 DSHPilot，是否继续？')) return
  setBusy(true); setMessage(undefined)
  try {
    await invoke('stop_harness')
    await invoke('install_app_update', { assetUrl })
    setMessage('应用更新已下载，正在退出并替换安装…')
  } catch (error) {
    await invoke('supervisor_restart').catch(() => undefined)
    setMessage(`更新失败：${error instanceof Error ? error.message : String(error)}`)
  } finally { setBusy(false) }
}

async function installCoreUpdateSafely(setBusy: (value: boolean) => void, setMessage: (value: string | undefined) => void): Promise<void> {
  if (await hasRunningSessions() && !window.confirm('当前有运行中的 session。更新会停止 Harness 并重启，是否继续？')) return
  setBusy(true); setMessage(undefined)
  try {
    await invoke('stop_harness')
    await invoke('runtime_update_from_url', { manifestUrl: RUNTIME_MANIFEST_URL, allowUnsignedLocal: true })
    const url = await invoke<string>('harness_url')
    setMessage('dsh 核心已更新，Harness 正在重启…')
    window.location.replace(url)
  } catch (error) {
    setMessage(`更新失败：${error instanceof Error ? error.message : String(error)}`)
  } finally { setBusy(false) }
}

/** Settings → Token 统计. Aggregated, precise usage from the host plugin's
 *  `/__dshpilot/usage` ledger (official per-message counts, not estimates).
 *  Switches between 日 / 周 / 月 and breaks the total into 输入 / 输出 /
 *  缓存读 / 缓存写 / 推理, with a per-bucket (day/hour) list. */
function TokenStats(): ReactNode {
  const [range, setRange] = useState<'day' | 'week' | 'month'>('day')
  const [data, setData] = useState<{ totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }; buckets: Array<{ key: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }>; recordCount: number } | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let cancelled = false
    const run = (): void => { void getJson<{ totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }; buckets: Array<{ key: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }>; recordCount: number }>(`/__dshpilot/usage?range=${range}`).then(value => { if (!cancelled) setData(value) }).catch(value => { if (!cancelled) setError(value instanceof Error ? value.message : String(value)) }) }
    run(); const timer = window.setInterval(run, 10_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [range])
  const fmt = (value: number): string => value.toLocaleString('en-US')
  const card = (label: string, value: number, color: string): ReactNode => createElement('div', { style: { flex: 1, minWidth: 130, border: '1px solid var(--dsw-alias-border-l2, #2a2a2a)', borderRadius: 10, padding: '10px 12px' } },
    createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
    createElement('div', { style: { fontSize: 20, fontWeight: 700, color } }, fmt(value)))
  const totals = data?.totals
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' } },
    createElement('nav', { style: { display: 'flex', gap: 6 } }, ...(['day', 'week', 'month'] as const).map(value => createElement('button', { key: value, type: 'button', onClick: () => setRange(value) }, value === 'day' ? '日' : value === 'week' ? '周' : '月'))),
    createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      card('输入 Input', totals?.inputTokens ?? 0, '#4d83ff'),
      card('输出 Output', totals?.outputTokens ?? 0, '#1a7f37'),
      card('缓存读 Cache read', totals?.cacheReadTokens ?? 0, '#b8860b'),
      card('缓存写 Cache write', totals?.cacheWriteTokens ?? 0, '#c7791a'),
      card('推理 Reasoning', totals?.reasoningTokens ?? 0, '#8a63d2')),
    createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, `共 ${data?.recordCount ?? 0} 条用量记录`),
    ...(data?.buckets ?? []).slice(-30).map(bucket => createElement('div', { key: bucket.key, style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)', padding: '4px 0' } },
      createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, bucket.key),
      createElement('span', null, `in ${fmt(bucket.inputTokens)} · out ${fmt(bucket.outputTokens)} · cache ${fmt(bucket.cacheReadTokens + bucket.cacheWriteTokens)}`))),
    error === undefined ? null : createElement('small', { style: { color: 'crimson' } }, error))
}

/** Settings → 检查更新. Always-visible status + install button (the sidebar
 *  footer action only appears when an update is pending). */
function CheckForUpdates(): ReactNode {
  const [appCheck, setAppCheck] = useState<AppUpdateCheck | undefined>()
  const [coreCheck, setCoreCheck] = useState<DshCoreUpdateCheck | undefined>()
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [checkError, setCheckError] = useState(false)

  const refresh = async (): Promise<void> => {
    setChecking(true)
    let errored = false
    try { setAppCheck(await invoke<AppUpdateCheck>('check_app_update')) } catch { errored = true; setAppCheck(undefined) }
    try { setCoreCheck(await invoke<DshCoreUpdateCheck>('check_dsh_core_update')) } catch { errored = true; setCoreCheck(undefined) }
    setCheckError(errored && appCheck === undefined && coreCheck === undefined)
    setChecking(false)
  }
  useEffect(() => { let cancelled = false; void refresh().catch(() => undefined); const timer = window.setInterval(() => { if (!cancelled) void refresh().catch(() => undefined) }, 24 * 60 * 60 * 1000); return () => { cancelled = true; window.clearInterval(timer) } }, [])

  const card = (title: string, statusText: string, button: ReactNode | null): ReactNode => createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l2, #2a2a2a)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
    createElement('div', { style: { fontWeight: 600 } }, title),
    createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, statusText),
    button)

  const appBtn = (appCheck?.available && appCheck.asset_url)
    ? createElement('button', { type: 'button', onClick: () => { void installAppUpdateSafely(appCheck.asset_url as string, setBusy, setMessage) }, disabled: busy, style: UPDATE_BTN }, busy ? '更新中…' : `安装 App 更新 ${appCheck.latest_version}`)
    : null
  const coreBtn = (coreCheck?.available && coreCheck.ready)
    ? createElement('button', { type: 'button', onClick: () => { void installCoreUpdateSafely(setBusy, setMessage) }, disabled: busy, style: UPDATE_BTN }, busy ? '更新中…' : '更新 dsh 核心')
    : null

  const summary = checking
    ? '检查更新中…'
    : (appCheck?.available || coreCheck?.available)
      ? '发现更新'
      : checkError
        ? '更新检查失败：无法连接更新服务器（请确认网络，或 GitHub Release 是否已发布）'
        : '已是最新版本'

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' } },
    createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, summary),
    card('DSHPilot App',
      appCheck?.available ? `发现新版本 ${appCheck.latest_version}（当前 ${appCheck.current_version}）` : `当前版本 ${appCheck?.current_version ?? '—'}`,
      appBtn),
    card('dsh 核心（DeepSeek Harness）',
      coreCheck?.available
        ? (coreCheck.ready ? `上游已有新版本（${(coreCheck.upstream_version ?? coreCheck.upstream_sha.slice(0, 8))}），可立即更新` : '上游已有新版本，正在等待 DSHPilot 构建发布运行时快照…')
        : `本地 ${coreCheck?.local_sha.slice(0, 8) ?? '—'} / 上游 ${coreCheck?.upstream_sha.slice(0, 8) ?? '—'}`,
      coreBtn),
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
  // Settings FIRST-LEVEL sections. The harness settings nav renders each row
  // with a single native glyph via its internal `navIcon(id)` map, and falls
  // back to the settings gear for any custom id (there is no `icon` field on
  // `SettingsSectionRow`). So we keep labels as plain text and let the harness
  // draw one consistent native gear icon per row — no emoji, no double-icon.
  // 远程控制 embeds the self-contained /__dshpilot/remote HTML guide+setup page.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dshpilot-remote', order: 50, label: '远程控制' },
    () => createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '72vh' } },
      createElement('iframe', {
        src: '/__dshpilot/remote',
        title: 'DSHPilot 远程控制',
        style: { flex: 1, width: '100%', border: '1px solid var(--dsw-alias-border-l2, #2a2a2a)', borderRadius: 8, background: '#fff' },
      }),
    ),
  ))
  // MCP 管理 renders the real React manager (the /__dshpilot/mcp route is a JSON
  // API, not an HTML page, so it cannot be embedded via iframe).
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dshpilot-mcp', order: 51, label: 'MCP 管理' },
    () => createElement('div', { style: { height: '100%' } }, createElement(McpManager)),
  ))
  // Token 统计 aggregates precise, official per-message usage from the host
  // plugin's /__dshpilot/usage ledger (day / week / month, input vs output vs cache).
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dshpilot-tokens', order: 52, label: 'Token 统计' },
    () => createElement('div', { style: { height: '100%' } }, createElement(TokenStats)),
  ))
  // 检查更新 is the always-visible settings surface for updates (the sidebar
  // footer action only shows up once an update is pending).
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dshpilot-update', order: 53, label: '检查更新' },
    () => createElement('div', { style: { height: '100%' } }, createElement(CheckForUpdates)),
  ))
}

/** The official Cordis client-plugin surface (name + inject + apply). Exported
 *  both as the default and here so any loader — ESM import or the Harness web
 *  shell's `window.__ModuleLoader__` closure-factory sink — gets the same
 *  stable object reference. */
export const plugin = { name, inject, apply }
export default plugin

// NOTE: registration with the Harness web-shell module loader is performed by
// the tsdown bundle wrapper (see tsdown.config.ts — it emits the
// `window.__ModuleLoader__.load({ id, factory })` closure around this module).
// Do NOT re-register here: the wrapper already does it, and a second call would
// throw "duplicate" in the Cordis client runner.
