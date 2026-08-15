import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { checkForAppUpdate, installAppUpdateSafely, type AppUpdateState } from './updater.js'

interface SupervisorStatus {
  state: string
  phase: string
  url?: string
  restart_count: number
  last_error?: string
}

function defaultRuntimeManifestUrl(): string {
  const windows = /Windows/u.test(navigator.userAgent)
  const suffix = windows ? 'windows-x64' : 'darwin-arm64'
  return `https://github.com/zoomc/dshpilot/releases/latest/download/current-${suffix}.json`
}

function App() {
  const [status, setStatus] = useState<SupervisorStatus>({ state: 'starting', phase: 'spawn', restart_count: 0 })
  const [updateState, setUpdateState] = useState<AppUpdateState>({ state: 'checking' })
  const [runtimeManifestUrl, setRuntimeManifestUrl] = useState(defaultRuntimeManifestUrl)
  const [runtimeMessage, setRuntimeMessage] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    void checkForAppUpdate().then(value => { if (!cancelled) setUpdateState(value) })
    const poll = (): void => { void invoke<SupervisorStatus>('supervisor_status').then(value => { if (!cancelled) setStatus(value) }).catch(() => undefined) }
    poll(); const timer = window.setInterval(poll, 500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const retry = (): void => { void invoke<SupervisorStatus>('supervisor_retry').then(setStatus).catch(error => setStatus({ ...status, state: 'failed', last_error: String(error) })) }
  const openHarness = (): void => { if (status.url !== undefined) window.location.replace(status.url) }
  const updateRuntime = (): void => {
    setRuntimeMessage('正在下载并验证 Runtime…')
    void invoke<string>('runtime_update_from_url', { manifestUrl: runtimeManifestUrl, allowUnsignedLocal: false })
      .then(value => setRuntimeMessage(value))
      .catch(error => setRuntimeMessage(`Runtime 更新失败：${error instanceof Error ? error.message : String(error)}`))
  }
  const installUpdate = (): void => {
    if (updateState.state !== 'available') return
    const update = updateState.update
    void installAppUpdateSafely(update, setUpdateState).catch(error => setUpdateState({ state: 'failed', error: error instanceof Error ? error.message : String(error) }))
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
    {status.state === 'ready' && updateState.state !== 'available' && updateState.state !== 'checking' && updateState.state !== 'downloading' && updateState.state !== 'installing' && <button type="button" onClick={openHarness}>打开 Harness</button>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
