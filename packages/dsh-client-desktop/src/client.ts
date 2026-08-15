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
  const [error, setError] = useState<string | undefined>()
  const refreshData = (): void => {
    void Promise.all([
      getJson<{ records: McpRecord[] }>('/__dshpilot/mcp').then(value => setMcp(value.records)),
      getJson<{ manifests: DocumentManifest[] }>('/__dshpilot/documents').then(value => setDocuments(value.manifests)),
      getJson<TokenSnapshot>('/__dshpilot/tokens').then(setTokens),
    ]).catch(value => setError(value instanceof Error ? value.message : String(value)))
  }
  useEffect(() => {
    let cancelled = false
    const read = (): void => { void fetch('/__dshpilot/health').then(response => response.json() as Promise<HealthSnapshot>).then(value => { if (!cancelled) setHealth(value) }).catch(() => { if (!cancelled) setHealth(undefined) }) }
    read(); refreshData(); const timer = window.setInterval(() => { read(); refreshData() }, 5_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  const toggleMcp = (record: McpRecord): void => { void postJson<{ records: McpRecord[] }>('/__dshpilot/mcp', { action: 'toggle', id: record.id, enabled: !record.enabled }).then(value => setMcp(value.records)).catch(value => setError(String(value))) }
  const addDocument = (): void => { const path = window.prompt('Local document path (the Desktop Host will validate and copy it):'); if (path !== null && path.trim() !== '') void postJson<{ manifest: DocumentManifest }>('/__dshpilot/documents', { action: 'add-path', path }).then(value => setDocuments(current => [value.manifest, ...current])).catch(value => setError(String(value))) }
  const content = tab === 'mcp'
    ? createElement('div', null, createElement('strong', null, `MCP servers (${mcp.length})`), ...mcp.map(record => createElement('div', { key: record.id, style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, createElement('span', null, `${record.serverName} · ${record.status}${record.toolCount === undefined ? '' : ` · ${record.toolCount} tools`}`), createElement('button', { type: 'button', onClick: () => toggleMcp(record) }, record.enabled ? 'Disable' : 'Enable'))))
    : tab === 'documents'
      ? createElement('div', null, createElement('strong', null, `Documents (${documents.length})`), createElement('button', { type: 'button', onClick: addDocument }, 'Add local file'), ...documents.map(document => createElement('div', { key: document.attachmentId }, `${document.name} · ${document.kind} · ${document.bytes} bytes`)))
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

export function apply(ctx: { effect(callback: () => void | (() => void), label?: string): unknown; slots: { inject(key: string, setup: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): () => void } }): void {
  ctx.effect(() => { void ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dshpilot-status', order: 200, label: 'DSHPilot' }, DshPilotStatusPanel)) }, 'dshpilot.client.status')
}

export default { name, inject, apply }
