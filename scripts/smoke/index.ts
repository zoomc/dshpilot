import { mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

function readinessUrl(line: string): string | undefined {
  const value = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  return value
}

async function main(): Promise<void> {
  const runtimeRoot = process.env.DSHPILOT_RUNTIME_ROOT
  const home = await mkdtemp(join(tmpdir(), 'dshpilot-smoke-'))
  const program = runtimeRoot ? join(runtimeRoot, 'node') : process.execPath
  const script = runtimeRoot ? join(runtimeRoot, 'dsh', 'lib', 'bin.js') : join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const child = spawn(program, [script, 'web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: runtimeRoot ? join(runtimeRoot, 'dsh') : harnessRoot,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  let url: string | undefined
  const consume = (stream: NodeJS.ReadableStream): void => {
    const lines = createInterface({ input: stream })
    lines.on('line', line => { output.push(line); url ??= readinessUrl(line) })
  }
  consume(child.stdout); consume(child.stderr)
  const deadline = Date.now() + 30_000
  while (!url && Date.now() < deadline) {
    if (child.exitCode !== null) break
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
  if (!url) {
    child.kill('SIGKILL')
    throw new Error(`Harness readiness failed:\n${output.join('\n')}`)
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Harness readiness URL returned HTTP ${response.status}`)
  const html = await response.text()
  if (!html.includes('<!doctype html>')) throw new Error('Harness Web UI did not return HTML')
  child.kill('SIGTERM')
  await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
  await rm(home, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, url, bytes: html.length }))
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
