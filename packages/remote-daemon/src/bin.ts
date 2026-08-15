import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const MAX_RESTARTS = 5

function readinessUrl(line: string): string | undefined {
  return line.match(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+/u)?.[0]
}

function probeUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1'
  return parsed.toString().replace(/\/$/u, '')
}

async function waitForHarnessReady(child: ChildProcess): Promise<string> {
  let output = ''
  let candidate: string | undefined
  const deadline = Date.now() + START_TIMEOUT_MS
  const read = (chunk: Buffer): void => {
    const text = chunk.toString('utf8'); output = `${output}${text}`.slice(-16_000); candidate ??= readinessUrl(text)
  }
  child.stdout?.on('data', read); child.stderr?.on('data', read)
  const exit = new Promise<never>((_, reject) => child.once('exit', code => reject(new Error(`Harness exited before readiness with code ${String(code)}: ${output}`))))
  while (Date.now() < deadline) {
    if (candidate !== undefined) {
      try {
        const response = await fetch(probeUrl(candidate))
        if (response.ok && (await response.text()).toLowerCase().includes('<!doctype html>')) return probeUrl(candidate)
      } catch { /* Harness is still binding its web server. */ }
    }
    await Promise.race([new Promise<void>(resolveSleep => setTimeout(resolveSleep, 250)), exit])
  }
  throw new Error(`Harness readiness timed out: ${output}`)
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null) return
  if (process.platform !== 'win32' && child.pid !== undefined) { try { process.kill(-child.pid, signal) } catch { child.kill(signal) } }
  else child.kill(signal)
}

async function stopTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  killTree(child, 'SIGTERM')
  await new Promise<void>(resolveStop => {
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolveStop() }, STOP_TIMEOUT_MS)
    child.once('exit', () => { clearTimeout(timer); resolveStop() })
  })
}

export interface HarnessSupervisorCommand {
  executable: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export async function superviseHarness(command: HarnessSupervisorCommand): Promise<void> {
  let stopping = false
  let current: ChildProcess | undefined
  const stop = (): void => { stopping = true; if (current !== undefined) void stopTree(current) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let restarts = 0
  while (!stopping) {
    current = spawn(command.executable, command.args, {
    cwd: command.cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...command.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    })
    current.stdout?.pipe(process.stdout); current.stderr?.pipe(process.stderr)
    try {
      const url = await waitForHarnessReady(current)
      process.stdout.write(`${JSON.stringify({ dshpilotHarness: 'ready', url, restartCount: restarts })}\n`)
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => { current?.once('error', rejectExit); current?.once('exit', resolveExit) })
      if (stopping || exitCode === 0) break
      throw new Error(`Harness exited unexpectedly with code ${String(exitCode)}`)
    } catch (error) {
      if (stopping) break
      await stopTree(current)
      if (restarts >= MAX_RESTARTS) throw new Error(`Harness supervisor entered failed state after ${MAX_RESTARTS} restarts: ${String(error)}`)
      restarts += 1
      const delay = Math.min(30_000, 500 * 2 ** Math.min(restarts - 1, 6))
      process.stderr.write(`DSHPilot Harness restart ${restarts}/${MAX_RESTARTS} in ${delay}ms: ${String(error)}\n`)
      await new Promise(resolveSleep => setTimeout(resolveSleep, delay))
    }
  }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
}

async function main(): Promise<void> {
  const runtimeRoot = process.env.DSHPILOT_RUNTIME_ROOT === undefined ? undefined : resolve(process.env.DSHPILOT_RUNTIME_ROOT)
  const home = resolve(process.env.DSH_HOME ?? join(process.cwd(), 'app-data', 'dsh-home'))
  const patchPath = process.env.DSHPILOT_PATCH_PATH ?? (runtimeRoot === undefined ? undefined : join(runtimeRoot, 'dshpilot.patch.yml'))
  if (patchPath === undefined) throw new Error('DSHPILOT_RUNTIME_ROOT or DSHPILOT_PATCH_PATH is required; remote daemon must launch the official Harness profile')
  await access(patchPath)
  const host = process.env.DSHPILOT_HARNESS_HOST ?? '127.0.0.1'
  const port = process.env.DSHPILOT_HARNESS_PORT ?? '0'
  const executable = runtimeRoot === undefined ? process.env.DSHPILOT_DSH_BIN ?? 'dsh' : join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  const args = runtimeRoot === undefined ? ['web', '--patch', patchPath] : [join(runtimeRoot, 'dsh', 'lib', 'bin.js'), 'web', '--patch', patchPath]
  args.push('--host', host, '--port', port)
  await superviseHarness({ executable, args, cwd: runtimeRoot === undefined ? process.cwd() : join(runtimeRoot, 'dsh'), env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSHPILOT_REMOTE_CONTROL: '1' } })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1 })
