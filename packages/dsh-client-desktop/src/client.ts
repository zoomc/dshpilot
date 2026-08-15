import { createElement, useEffect, useState } from 'react'

export const name = 'dshpilot-client'
export const inject = ['slots'] as const

interface HealthSnapshot { status: string; runtimeVersion: string; harnessVersion: string; webUiReady: boolean; apiReady: boolean }
interface McpRecord { id: string; serverName: string; transport: string; enabled: boolean; status: string; toolCount?: number; lastError?: string }
interface DocumentManifest { attachmentId: string; name: string; kind: string; bytes: number; createdAt: string }
interface TokenSnapshot { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; source: 'official' | 'estimate'; estimate: boolean; contextWindow?: number }; note?: string }

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
  const removeMcp = (record: McpRecord): void => { if (!window.confirm(`Remove MCP server ${record.serverName}?`)) return; void postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'remove', id: record.id }).then(value => setMcp(value.records)).catch(value => setError(String(value))) }
  const importMcp = (): void => {
    const text = window.prompt('Paste an MCP JSON configuration for preview and diff:')
    if (text === null || text.trim() === '') return
    void postJson<{ preview: { diff: { added: string[]; changed: string[]; unchanged: string[] }; warnings: string[] }; records: McpRecord[] }>('/__dshpilot/mcp', { action: 'preview-import', source: 'desktop-import.json', text }).then(preview => {
      const summary = `Added: ${preview.preview.diff.added.length}; changed: ${preview.preview.diff.changed.length}; unchanged: ${preview.preview.diff.unchanged.length}${preview.preview.warnings.length === 0 ? '' : `\nWarnings: ${preview.preview.warnings.join('; ')}`}`
      if (!window.confirm(`${summary}\nApply this import?`)) return undefined
      return postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'apply-import', preview: preview.preview, confirm: true }).then(value => setMcp(value.records))
    }).catch(value => setError(String(value)))
  }
  const addDocument = (): void => { const path = window.prompt('Local document path (the Desktop Host will validate and copy it):'); if (path !== null && path.trim() !== '') void postJson<{ manifest: DocumentManifest }>('/__dshpilot/documents', { action: 'add-path', path }).then(value => setDocuments(current => [value.manifest, ...current])).catch(value => setError(String(value))) }
  const inspectDocument = (document: DocumentManifest): void => { void postJson<unknown>('/__dshpilot/documents', { action: 'inspect', attachmentId: document.attachmentId }).then(value => window.alert(JSON.stringify(value, null, 2))).catch(value => setError(String(value))) }
  const content = tab === 'mcp'
    ? createElement('div', null, createElement('strong', null, `MCP servers (${mcp.length})`), createElement('button', { type: 'button', onClick: importMcp }, 'Preview/import JSON'), ...mcp.map(record => createElement('div', { key: record.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, createElement('span', null, `${record.serverName} · ${record.status}${record.toolCount === undefined ? '' : ` · ${record.toolCount} tools`}`), createElement('button', { type: 'button', onClick: () => toggleMcp(record) }, record.enabled ? 'Disable' : 'Enable'), createElement('button', { type: 'button', onClick: () => removeMcp(record) }, 'Remove'))))
    : tab === 'documents'
      ? createElement('div', null, createElement('strong', null, `Documents (${documents.length})`), createElement('button', { type: 'button', onClick: addDocument }, 'Add local file'), ...documents.map(document => createElement('div', { key: document.attachmentId }, `${document.name} · ${document.kind} · ${document.bytes} bytes`, createElement('button', { type: 'button', onClick: () => inspectDocument(document) }, 'Inspect'))))
      : tab === 'tokens'
        ? createElement('div', null, createElement('strong', null, 'Context / Token Inspector'), createElement('div', null, `Input: ${tokens?.usage.inputTokens ?? '—'} · Output: ${tokens?.usage.outputTokens ?? '—'}`), createElement('div', null, `Total: ${tokens?.usage.totalTokens ?? '—'} · source=${tokens?.usage.source}`), tokens?.note === undefined ? null : createElement('small', null, tokens.note))
        : createElement('div', null, createElement('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, 'DSHPilot'), createElement('span', null, health?.status === 'ready' ? 'Harness ready' : 'Checking Harness…'), createElement('span', null, `Runtime: ${health?.runtimeVersion ?? 'unknown'}`), createElement('span', null, `Harness: ${health?.harnessVersion ?? 'unknown'}`))
  return createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    'data-dshpilot-status': 'true',
  },
  createElement('nav', { style: { display: 'flex', gap: 4 } }, ...(['overview', 'mcp', 'documents', 'tokens'] as const).map(value => createElement('button', { key: value, type: 'button', onClick: () => setTab(value) }, value))),
  content,
  error === undefined ? null : createElement('small', { style: { color: 'crimson' } }, error))
}

export function apply(ctx: { slots: { inject(key: string, setup: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): () => void } }): void {
  // The status/token surface belongs to the conversation composer context.
  // Keep registration behind the official inject seam so Cordis owns its
  // lifetime and removes it during HMR/unload.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'dshpilot-status', order: 200, label: 'DSHPilot' }, DshPilotStatusPanel))
}

export default { name, inject, apply }
