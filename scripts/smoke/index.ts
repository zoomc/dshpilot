import { access, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpManager } from '../../packages/desktop-host/src/index.js'
import * as hostPlugin from '../../packages/dsh-plugin-desktop/src/index.js'
import * as clientPlugin from '../../packages/dsh-client-desktop/src/index.js'
import * as clientBrowserPlugin from '../../packages/dsh-client-desktop/src/client.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

function readinessUrl(line: string): string | undefined {
  const value = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  return value
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `dshpilot-smoke-${method}`, method, payload }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const envelope = await response.json() as { result?: { ok?: boolean; value?: T; error?: { code?: string; message?: string } } }
  if (envelope.result?.ok !== true) throw new Error(`${method} failed: ${envelope.result?.error?.code ?? 'unknown'}: ${envelope.result?.error?.message ?? 'unknown error'}`)
  return envelope.result.value as T
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>(resolveExit => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveExit() }, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
}

function bootGraph(html: string): Array<{ id?: string; url?: string; inject?: string[] }> {
  const script = html.match(/window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/u)?.[1]
  if (script === undefined) throw new Error('Harness Web UI did not expose __DSH_BOOT__')
  const value = JSON.parse(script) as { entries?: Array<{ id?: string; url?: string; inject?: string[] }> }
  return Array.isArray(value.entries) ? value.entries : []
}

async function main(): Promise<void> {
  const runtimeRoot = process.env.DSHPILOT_RUNTIME_ROOT === undefined ? undefined : resolve(process.env.DSHPILOT_RUNTIME_ROOT)
  const home = await mkdtemp(join(tmpdir(), 'dshpilot-smoke-'))
  let child: ReturnType<typeof spawn> | undefined
  try {
  const manager = new McpManager(home)
  await manager.upsert({
    id: 'smoke-disabled', serverName: 'smoke_disabled', transport: 'stdio', enabled: false, status: 'disabled',
    command: process.execPath, args: [], env: {}, envRefs: {}, headers: {}, headerRefs: {}, updatedAt: new Date().toISOString(),
  })
  if (hostPlugin.name !== 'dshpilot-desktop' || typeof hostPlugin.apply !== 'function'
    || clientPlugin.name !== 'dshpilot-client' || typeof clientPlugin.apply !== 'function'
    || clientBrowserPlugin.name !== 'dshpilot-client' || typeof clientBrowserPlugin.apply !== 'function') {
    throw new Error('DSHPilot Host/Client plugin loading smoke failed')
  }
  const clientSlotKeys: string[] = []
  const clientRegistrations: Array<Record<string, unknown>> = []
  clientBrowserPlugin.apply({
    slots: {
      inject(key: string, setup: () => unknown): unknown { clientSlotKeys.push(key); return setup() },
      register(options: Record<string, unknown>): () => void { clientRegistrations.push(options); return () => { const index = clientRegistrations.indexOf(options); if (index >= 0) clientRegistrations.splice(index, 1) } },
    },
  })
  if (!clientSlotKeys.includes('conversation.composer.dock') || !clientSlotKeys.includes('sidebar.footer.action') || !clientRegistrations.some(value => value.id === 'dshpilot-status') || !clientRegistrations.some(value => value.id === 'dshpilot-update')) {
    throw new Error('DSHPilot Client Plugin did not register the official composer dock')
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
  const spawnedChild = spawn(program, args, {
    cwd: runtimeRoot ? join(runtimeRoot, 'dsh') : harnessRoot,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSHPILOT_REMOTE_CONTROL: '1', DSHPILOT_REMOTE_PRINT_PAIRING: '1', DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = spawnedChild
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
  consume(spawnedChild.stdout); consume(spawnedChild.stderr)
  const deadline = Date.now() + 30_000
  while (!url && Date.now() < deadline) {
    if (spawnedChild.exitCode !== null) break
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
  }
  if (!url) {
    await stopChild(spawnedChild)
    throw new Error(`Harness readiness failed:\n${output.join('\n')}`)
  }
  if (runtimeRoot) {
    const remoteDeadline = Date.now() + 10_000
    while (remotePort === undefined && Date.now() < remoteDeadline && spawnedChild.exitCode === null) await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Harness readiness URL returned HTTP ${response.status}`)
  const html = await response.text()
  if (!html.includes('<!doctype html>')) throw new Error('Harness Web UI did not return HTML')

  // Exercise the official, keyless-safe Host API seams. These calls create no
  // model turn, but prove that the Web UI can list/create/read sessions,
  // describe settings, and resolve the model catalog after a real boot.
  const before = await rpc<{ items?: unknown[] }>(url, 'session.list', {})
  const created = await rpc<{ sessionId?: string }>(url, 'session.create', {})
  if (typeof created.sessionId !== 'string' || created.sessionId.length === 0) throw new Error('Harness session.create returned no sessionId')
  const after = await rpc<{ items?: Array<{ sessionId?: string }> }>(url, 'session.list', {})
  if (!Array.isArray(before.items) || !after.items?.some(item => item.sessionId === created.sessionId)) throw new Error('Harness session.list did not expose the created session')
  await rpc(url, 'session.history', { sessionId: created.sessionId, maxMessages: 10 })
  await rpc(url, 'session.models', { sessionId: created.sessionId })
  await rpc(url, 'llm.models', {})
  const settings = await rpc<{ namespaces?: unknown[] }>(url, 'settings.describe', {})
  if (!Array.isArray(settings.namespaces)) throw new Error('Harness settings.describe returned no namespace projection')
  let hostPluginLoaded = false
  if (runtimeRoot) {
    const bootEntries = bootGraph(html)
    const clientEntry = bootEntries.find(entry => entry.id === '@dshpilot/dsh-client-desktop')
    if (clientEntry?.url === undefined || !clientEntry.inject?.includes('@deepseek-ai/dsh-client-runtime')) throw new Error(`Packaged DSHPilot Client Plugin is absent from the Harness boot graph: ${bootEntries.map(entry => entry.id).filter(Boolean).join(', ')}`)
    const clientBundle = await fetch(new URL(clientEntry.url, url))
    const clientBundleText = await clientBundle.text()
    if (!clientBundle.ok || !clientBundleText.includes('dshpilot-status') || !clientBundleText.includes('conversation.composer.dock')) throw new Error('Packaged DSHPilot Client Plugin bundle did not contain the registered UI seam')
    const health = await fetch(`${url}/__dshpilot/health`)
    if (!health.ok || (await health.json() as { status?: string }).status !== 'ready') throw new Error('Packaged DSHPilot Host Plugin health check failed')
    const status = await fetch(`${url}/__dshpilot/plugin-status`)
    const pluginStatus = await status.json() as { hostPlugin?: boolean; officialServices?: { webServer?: boolean; apiProxy?: boolean; tools?: boolean }; documentTools?: string[]; resourceTools?: string[] }
    hostPluginLoaded = status.ok && pluginStatus.hostPlugin === true && pluginStatus.officialServices?.tools === true && pluginStatus.documentTools?.length === 6 && pluginStatus.resourceTools?.length === 6
    if (!hostPluginLoaded) throw new Error('Packaged DSHPilot Host Plugin registration check failed')
    const mcp = await fetch(`${url}/__dshpilot/mcp`)
    const mcpValue = await mcp.json() as { records?: Array<{ id?: string; status?: string }>; liveReload?: boolean }
    if (!mcp.ok || mcpValue.liveReload !== true || !mcpValue.records?.some(record => record.id === 'smoke-disabled' && record.status === 'disabled')) throw new Error('Packaged DSHPilot MCP composition check failed')
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
  console.log(JSON.stringify({ ok: true, url, bytes: html.length, hostPluginLoaded, clientPlugin: clientPlugin.name === 'dshpilot-client' }))
  } finally {
    if (child !== undefined) await stopChild(child)
    await rm(home, { recursive: true, force: true })
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
