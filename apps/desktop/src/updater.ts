import { check, type Update } from '@tauri-apps/plugin-updater'
import { invoke } from '@tauri-apps/api/core'

export type AppUpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; update: Update }
  | { state: 'downloading'; downloaded: number; total?: number }
  | { state: 'ready'; update: Update }
  | { state: 'installing' }
  | { state: 'failed'; error: string }

export async function checkForAppUpdate(): Promise<AppUpdateState> {
  try {
    const update = await check()
    return update === null ? { state: 'idle' } : { state: 'available', update }
  } catch (error) { return { state: 'failed', error: error instanceof Error ? error.message : String(error) } }
}

export async function installAppUpdate(update: Update, onProgress?: (state: AppUpdateState) => void): Promise<void> {
  let downloaded = 0
  onProgress?.({ state: 'downloading', downloaded })
  // `downloadAndInstall` downloads, installs, and (on Tauri v2) automatically
  // relaunches the app once the new binary is in place — this closes the P0
  // "no reliable relaunch" gap. We explicitly stop the managed Harness first
  // (see installAppUpdateSafely) so the restart never strands a live session.
  await update.downloadAndInstall(event => {
    if (event.event === 'Started') { onProgress?.({ state: 'downloading', downloaded: 0, total: event.data.contentLength ?? undefined }); return }
    if (event.event === 'Progress') { downloaded += event.data.chunkLength; onProgress?.({ state: 'downloading', downloaded }); return }
    onProgress?.({ state: 'installing' })
  })
}

export async function installAppUpdateSafely(update: Update, onProgress?: (state: AppUpdateState) => void): Promise<void> {
  await invoke('stop_harness')
  try {
    await installAppUpdate(update, onProgress)
  } catch (error) {
    // A failed app update must not strand the official Harness process in a
    // stopped state. The successful updater path normally relaunches the app.
    await invoke('supervisor_restart').catch(() => undefined)
    throw error
  }
}
