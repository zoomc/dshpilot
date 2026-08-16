import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { checkForAppUpdate, installAppUpdateSafely, type AppUpdateState } from './updater.js'

interface SupervisorStatus {
  state: string
  phase: string
  url?: string
  restart_count: number
  last_error?: string
}

interface DeepLinkEvent { urls?: string[]; argv?: string[] }

function harnessRoute(value: string, base: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'dshpilot:') return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, base).toString()
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '') return parsed.toString()
  } catch { /* malformed argv is ignored */ }
  return undefined
}

function defaultRuntimeManifestUrl(): string {
  const windows = /Windows/u.test(navigator.userAgent)
  const suffix = windows ? 'windows-x64' : 'darwin-arm64'
  return `https://github.com/zoomc/dshpilot/releases/download/runtime/current-${suffix}.json`
}

function App() {
  const [status, setStatus] = useState<SupervisorStatus>({ state: 'starting', phase: 'spawn', restart_count: 0 })
  const [updateState, setUpdateState] = useState<AppUpdateState>({ state: 'checking' })
  const [runtimeManifestUrl, setRuntimeManifestUrl] = useState(defaultRuntimeManifestUrl)
  const [runtimeMessage, setRuntimeMessage] = useState<string | undefined>()
  const [iframeSrc, setIframeSrc] = useState<string | undefined>(undefined)
  const pendingDeepLinks = useRef<string[]>([])
  const harnessUrl = status.url

  useEffect(() => {
    let cancelled = false
    void checkForAppUpdate().then(value => { if (!cancelled) setUpdateState(value) })
    // The Tauri setup hook starts the managed Harness, while this explicit
    // preflight also covers a window restored after a supervisor failure or
    // an already-running registered dsh service.
    void invoke<SupervisorStatus>('ensure_harness').then(value => { if (!cancelled) setStatus(value) }).catch(error => { if (!cancelled) setStatus(current => ({ ...current, state: 'failed', phase: 'preflight', last_error: String(error) })) })
    const poll = (): void => { void invoke<SupervisorStatus>('supervisor_status').then(value => { if (!cancelled) setStatus(value) }).catch(() => undefined) }
    poll(); const timer = window.setInterval(poll, 500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  // Once Harness is ready, embed it in a full-window iframe so the harness web
  // UI (including Settings → 插件 with our contributed tabs) renders natively.
  useEffect(() => {
    if (status.state === 'ready' && harnessUrl !== undefined && iframeSrc === undefined) {
      setIframeSrc(harnessUrl)
    }
  }, [status.state, harnessUrl, iframeSrc])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<DeepLinkEvent>('dshpilot://open', event => {
      const values = [...(event.payload.urls ?? []), ...(event.payload.argv ?? []).filter(value => value.startsWith('dshpilot:'))]
      if (cancelled) return
      if (status.state === 'ready' && harnessUrl !== undefined) {
        const next = values[0]
        const route = next === undefined ? undefined : harnessRoute(next, harnessUrl)
        if (route !== undefined) setIframeSrc(route)
      } else {
        pendingDeepLinks.current.push(...values)
      }
    }).then(value => { if (cancelled) value(); else unlisten = value }).catch(() => undefined)
    return () => { cancelled = true; unlisten?.() }
  }, [status.state, harnessUrl])

  // Flush any deep links that arrived before Harness was ready.
  useEffect(() => {
    if (status.state !== 'ready' || harnessUrl === undefined) return
    const pending = pendingDeepLinks.current.shift()
    const route = pending === undefined ? undefined : harnessRoute(pending, harnessUrl)
    if (route !== undefined) setIframeSrc(route)
  }, [status.state, harnessUrl])

  const retry = (): void => { void invoke<SupervisorStatus>('supervisor_retry').then(setStatus).catch(error => setStatus({ ...status, state: 'failed', last_error: String(error) })) }
  const updateRuntime = (): void => {
    setRuntimeMessage('正在下载并验证 Runtime…')
    void invoke<string>('runtime_update_from_url', { manifestUrl: runtimeManifestUrl, allowUnsignedLocal: false })
      .then(value => setRuntimeMessage(value))
      .catch(error => setRuntimeMessage(`Runtime 更新失败：${error instanceof Error ? error.message : String(error)}`))
  }
  const installUpdate = (): void => {
    if (updateState.state !== 'available') return
    const update = updateState.update
    // Per the update contract, confirm before restarting when a Harness session
    // may be in flight. A running supervisor means the user already navigated
    // into the Harness, so an active session is plausible and interruption must
    // be acknowledged.
    if (status.state === 'ready' && !window.confirm('安装应用更新将重启 DSHPilot，进行中的 Harness 会话会中断。确认继续？')) return
    void installAppUpdateSafely(update, setUpdateState).catch(error => setUpdateState({ state: 'failed', error: error instanceof Error ? error.message : String(error) }))
  }

  if (status.state === 'ready' && iframeSrc !== undefined) {
    // The desktop window is now just the Harness web UI. Feature entries
    // (远程控制 / MCP 管理 / …) live inside the harness Settings → 插件 panel,
    // contributed by @dshpilot/dsh-client-desktop, so no separate top menu bar
    // is needed here.
    return (
      <iframe src={iframeSrc} style={{ width: '100%', height: '100%', border: 'none' }} title="Harness" />
    )
  }

  return <main style={{ fontFamily: 'system-ui', padding: 32 }}>
    <h1>DSHPilot</h1>
    <p>Harness: {status.state} ({status.phase})</p>
    {status.last_error !== undefined && <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{status.last_error}</p>}
    {status.state === 'failed' && <button type="button" onClick={retry}>Retry</button>}
    {updateState.state === 'available' && <section style={{ marginTop: 24 }}>
      <p>应用更新可用：{updateState.update.version}</p>
      <button type="button" onClick={installUpdate}>安装应用更新</button>
    </section>}
    {updateState.state === 'checking' && <p>正在检查应用更新…</p>}
    {updateState.state === 'downloading' && <p>正在下载应用更新：{updateState.downloaded}{updateState.total === undefined ? '' : ` / ${updateState.total}`} bytes</p>}
    {updateState.state === 'installing' && <p>正在安装应用更新…</p>}
    {updateState.state === 'failed' && <p style={{ color: 'darkorange' }}>应用更新检查/安装失败：{updateState.error}</p>}
    <section style={{ marginTop: 24 }}>
      <h2>Harness Runtime</h2>
      <input style={{ minWidth: 520 }} value={runtimeManifestUrl} onChange={event => setRuntimeManifestUrl(event.target.value)} aria-label="Runtime manifest URL" />
      <button type="button" onClick={updateRuntime} disabled={status.state === 'stopping' || status.state === 'starting'}>更新并健康检查</button>
      {runtimeMessage !== undefined && <p style={{ whiteSpace: 'pre-wrap' }}>{runtimeMessage}</p>}
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
