import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  const [status, setStatus] = useState('Starting DeepSeek Harness…')

  useEffect(() => {
    let cancelled = false
    void invoke<string>('harness_url').then((url) => {
      if (!cancelled) window.location.replace(url)
    }).catch((error: unknown) => {
      if (!cancelled) setStatus(`Unable to start Harness: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [])

  return <main style={{ fontFamily: 'system-ui', padding: 32 }}>{status}</main>
}

createRoot(document.getElementById('root')!).render(<App />)
