import { access, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpManager } from '../../packages/desktop-host/src/index.js'
import * as hostPlugin from '../../packages/dsh-plugin-desktop/src/index.js'
import * as clientPlugin from '../../packages/dsh-client-desktop/src/index.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

function readinessUrl(line: string): string | undefined {
  const value = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  return value
}

async function main(): Promise<void> {
  const runtimeRoot = process.env.DSHPILOT_RUNTIME_ROOT === undefined ? undefined : resolve(process.env.DSHPILOT_RUNTIME_ROOT)
  const home = await mkdtemp(join(tmpdir(), 'dshpilot-smoke-'))
  const manager = new McpManager(home)
  await manager.upsert({
    id: 'smoke-disabled', serverName: 'smoke_disabled', transport: 'stdio', enabled: false, status: 'disabled',
    command: process.execPath, args: [], env: {}, envRefs: {}, headers: {}, headerRefs: {}, updatedAt: new Date().toISOString(),
  })
  if (hostPlugin.name !== 'dshpilot-desktop' || typeof hostPlugin.apply !== 'function'
    || clientPlugin.name !== 'dshpilot-client' || typeof clientPlugin.apply !== 'function') {
    throw new Error('DSHPilot Host/Client plugin loading smoke failed')
  }
  const runtimeNode = process.platform === 'win32' ? 'node.exe' : 'node'
  const program = runtimeRoot ? join(runtimeRoot, runtimeNode) : process.execPath
  const script = runtimeRoot ? join(runtimeRoot, 'dsh', 'lib', 'bin.js') : join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const args = [script, 'web', '--patch', manager.patchPath]
  if (runtimeRoot) {
    try { await access(join(runtimeRoot, 'dshpilot.patch.yml')); args.push('--patch', join(runtimeRoot, 'dshpilot.patch.yml')) } catch { /* development runtime without packaged plugin */ }
    const profileFallback = join(home, 'profiles', 'node_modules', '@dshpilot')
    await mkdir(profileFallback, { recursive: true })
    for (const packageName of ['control-contracts', 'desktop-host', 'dsh-plugin-desktop', 'dsh-client-desktop', 'remote-daemon']) {
      await cp(join(runtimeRoot, 'dsh', 'node_modules', '@dshpilot', packageName), join(profileFallback, packageName), { recursive: true })
    }
  }
  args.push('--host', '127.0.0.1', '--port', '0')
  const child = spawn(program, args, {
    cwd: runtimeRoot ? join(runtimeRoot, 'dsh') : harnessRoot,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSHPILOT_REMOTE_CONTROL: '1', DSHPILOT_REMOTE_PRINT_PAIRING: '1', DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  let url: string | undefined
  let remotePort: number | undefined
  let pairingCode: string | undefined
  const consume = (stream: NodeJS.ReadableStream): void => {
    const lines = createInterface({ input: stream })
    lines.on('line', line => {
      output.push(line); url ??= readinessUrl(line)
      try {
        const value = JSON.parse(line) as { dshpilotRemote?: string; port?: number; dshpilotPairingOffer?: { code?: unknown } }
        if (value.dshpilotRemote === 'ready' && Number.isSafeInteger(value.port)) remotePort = value.port
        if (typeof value.dshpilotPairingOffer === 'object' && value.dshpilotPairingOffer !== null && typeof (value.dshpilotPairingOffer as { code?: unknown }).code === 'string') pairingCode = (value.dshpilotPairingOffer as { code: string }).code
      } catch { /* ordinary Harness output */ }
    })
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
  if (runtimeRoot) {
    const remoteDeadline = Date.now() + 10_000
    while (remotePort === undefined && Date.now() < remoteDeadline && child.exitCode === null) await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Harness readiness URL returned HTTP ${response.status}`)
  const html = await response.text()
  if (!html.includes('<!doctype html>')) throw new Error('Harness Web UI did not return HTML')
  let hostPluginLoaded = false
  if (runtimeRoot) {
    const health = await fetch(`${url}/__dshpilot/health`)
    if (!health.ok || (await health.json() as { status?: string }).status !== 'ready') throw new Error('Packaged DSHPilot Host Plugin health check failed')
    const status = await fetch(`${url}/__dshpilot/plugin-status`)
    const pluginStatus = await status.json() as { hostPlugin?: boolean; officialServices?: { webServer?: boolean; apiProxy?: boolean; tools?: boolean }; documentTools?: string[] }
    hostPluginLoaded = status.ok && pluginStatus.hostPlugin === true && pluginStatus.officialServices?.tools === true && pluginStatus.documentTools?.length === 6
    if (!hostPluginLoaded) throw new Error('Packaged DSHPilot Host Plugin registration check failed')
    if (remotePort === undefined) throw new Error('Packaged DSHPilot remote control did not announce readiness')
    const remoteHealth = await fetch(`http://127.0.0.1:${String(remotePort)}/health`)
    if (!remoteHealth.ok || (await remoteHealth.json() as { ok?: boolean }).ok !== true) throw new Error('Packaged DSHPilot remote control health check failed')
    if (pairingCode === undefined) throw new Error('Packaged DSHPilot remote control did not announce a pairing offer')
    const paired = await fetch(`http://127.0.0.1:${String(remotePort)}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairingCode, name: 'packaged-smoke' }) })
    const pairedValue = await paired.json() as { ok?: boolean; value?: { token?: string; device?: { deviceId?: string } } }
    if (!paired.ok || pairedValue.ok !== true || pairedValue.value?.token === undefined) throw new Error('Packaged DSHPilot remote pairing failed')
    const serverInfo = await fetch(`http://127.0.0.1:${String(remotePort)}/v1/server`, { headers: { authorization: `Bearer ${pairedValue.value.token}` } })
    const serverValue = await serverInfo.json() as { ok?: boolean; value?: { capabilities?: string[] } }
    if (!serverInfo.ok || serverValue.ok !== true || !serverValue.value?.capabilities?.includes('restricted-control')) throw new Error('Packaged DSHPilot remote authenticated API check failed')
  }
  child.kill('SIGTERM')
  await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
  await rm(home, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, url, bytes: html.length, hostPluginLoaded, clientPlugin: clientPlugin.name === 'dshpilot-client' }))
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
