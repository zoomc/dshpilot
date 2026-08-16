/**
 * DSHPilot remote-control auto-configuration engine.
 *
 * Brings up the full WAN/LAN remote-control stack with zero required domain or
 * billing: a blind relay on loopback, a free Cloudflare Quick Tunnel (no
 * account, no domain, no card) in front of it, and the Harness control plane
 * wired to the relay. Emits newline-delimited JSON progress events so a UI
 * (the in-Harness settings page) can stream them.
 *
 * Exit codes: 0 = bring-up succeeded and the stack is running; non-zero = fatal.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { relayAuthenticate, relayHello, relayWebSocketUrl } from '../../packages/remote-relay/src/index.js'
import WebSocket from 'ws'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

// ---------------------------------------------------------------------------
// Bilingual messaging
// ---------------------------------------------------------------------------
type Lang = 'zh' | 'en'
const detectedLang: Lang = /^(zh|cn)/iu.test(process.env.LANG ?? process.env.LC_ALL ?? '') ? 'zh' : (process.argv.includes('--lang') ? (process.argv[process.argv.indexOf('--lang') + 1] === 'zh' ? 'zh' : 'en') : 'zh')
function arg(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1] ?? fallback }
function flag(name: string): boolean { return process.argv.includes(name) }

const M = {
  start: { zh: '开始配置远程控制', en: 'Starting remote-control setup' },
  checkCloudflared: { zh: '检查 cloudflared 是否安装', en: 'Checking cloudflared installation' },
  cloudflaredVersion: { zh: '检测到 cloudflared 版本', en: 'Detected cloudflared version' },
  checkPort: { zh: '检查本地端口是否空闲', en: 'Checking local port availability' },
  checkLogin: { zh: '检查 Cloudflare 登录态（命名隧道需要）', en: 'Checking Cloudflare login state (named tunnel needs it)' },
  startTunnel: { zh: '启动 Cloudflare 隧道', en: 'Starting Cloudflare tunnel' },
  tunnelReady: { zh: '隧道已就绪', en: 'Tunnel is ready' },
  startRelay: { zh: '启动盲中继（loopback）', en: 'Starting blind relay (loopback)' },
  relayReady: { zh: '中继已就绪', en: 'Relay is ready' },
  startControl: { zh: '启动 Harness 控制面', en: 'Starting Harness control plane' },
  controlReady: { zh: '控制面已就绪', en: 'Control plane is ready' },
  selfTest: { zh: '自检中继连通性', en: 'Self-testing relay connectivity' },
  done: { zh: '配置完成', en: 'Setup complete' },
  staying: { zh: '远程控制栈运行中（Ctrl-C 停止）', en: 'Remote-control stack is running (Ctrl-C to stop)' },
} as const
function t(key: keyof typeof M): string { return M[key][detectedLang] }

interface Progress { type: 'progress'; step: string; message: string }
interface Result { type: 'result'; ok: true; setup: SetupResult }
interface ErrorEvent { type: 'error'; ok: false; code: string; message: string; hint: string; fatal: boolean }
type Event = Progress | Result | ErrorEvent
function emit(event: Event): void { process.stdout.write(`${JSON.stringify(event)}\n`) }
function progress(step: string, message: string): void { emit({ type: 'progress', step, message }) }

const langHint = { zh: '（中文）', en: '(English)' }
function err(code: string, message: string, hint: string, fatal = true): never {
  emit({ type: 'error', ok: false, code, message: `${message} ${langHint[detectedLang]}`, hint, fatal })
  process.exitCode = 1
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// Local environment pre-checks
// ---------------------------------------------------------------------------
function run(command: string, args: string[], opts: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env: { ...process.env, ...opts.env }, stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', rejectRun)
    child.on('exit', code => resolveRun({ code: code ?? 0, stdout, stderr }))
  })
}

async function which(bin: string): Promise<string | undefined> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [bin], { capture: true }).catch(() => undefined)
  return r && r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim().split(/\r?\n/)[0]! : undefined
}

async function portFree(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const srv = createServer()
    srv.once('error', () => resolvePort(false))
    srv.once('listening', () => { srv.close(() => resolvePort(true)) })
    srv.listen(port, '127.0.0.1')
  })
}

// ---------------------------------------------------------------------------
// Cloudflare Quick / named tunnel
// ---------------------------------------------------------------------------
interface TunnelResult { url: string; fatal: boolean; child: ChildProcess }
async function startTunnel(relayPort: number): Promise<TunnelResult> {
  progress('tunnel', t('startTunnel'))
  const domain = flag('--domain') ? arg('--domain', '') : ''
  const tunnel = flag('--tunnel') ? arg('--tunnel', '') : ''
  const useNamed = domain !== '' && tunnel !== ''
  if (useNamed) {
    const login = await run('cloudflared', ['tunnel', 'list'], { capture: true }).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    if (login.code !== 0) err('LOGIN_REQUIRED', 'Cloudflare 未登录，命名隧道需要登录', 'Run: cloudflared login  (然后在 Cloudflare 面板把 <domain> 指向该隧道)')
  }
  const url = `http://127.0.0.1:${relayPort}`
  const protocol = flag('--protocol') ? arg('--protocol', 'auto') : 'auto'
  const args = useNamed
    ? ['tunnel', 'run', '--url', url, '--protocol', protocol, tunnel]
    : ['tunnel', '--url', url, '--protocol', protocol]
  const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const captured = await new Promise<TunnelResult>((resolveTunnel, rejectTunnel) => {
    let buffer = ''
    const timeout = setTimeout(() => rejectTunnel(new Error('tunnel-start-timeout')), 30_000)
    const finish = (value: TunnelResult): void => { clearTimeout(timeout); child.stdout?.off('data', onData); child.stderr?.off('data', onData); resolveTunnel(value) }
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8'); buffer += text
      const candidates = [...text.matchAll(/https:\/\/[^\s'"]+/gu)].map(m => m[0]!.replace(/\/$/u, ''))
      const found = candidates.find(u => useNamed ? u.includes(domain) && !u.includes('cloudflare.com/') : /[a-z0-9-]+\.trycloudflare\.com$/u.test(u))
      if (found !== undefined) { finish({ url: found, fatal: false, child }); return }
      if (/ERR|failed to (connect|establish|dial)/iu.test(text)) {
        const quic = /quic/iu.test(buffer)
        finish({ url: '', fatal: quic, child })
      }
    }
    child.stdout?.on('data', onData); child.stderr?.on('data', onData)
    child.on('exit', () => rejectTunnel(new Error('tunnel-exited')))
  }).catch(async () => {
    // QUIC handshake failure → retry once over http2.
    child.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 500))
    const retry = spawn('cloudflared', [...(useNamed ? ['tunnel', 'run', '--url', url, '--protocol', 'http2', tunnel] : ['tunnel', '--url', url, '--protocol', 'http2'])], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    const result = await new Promise<TunnelResult>((resolveRetry) => {
      const t2 = setTimeout(() => resolveRetry({ url: '', fatal: true, child: retry }), 30_000)
      const onD = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        const candidates = [...text.matchAll(/https:\/\/[^\s'"]+/gu)].map(m => m[0]!.replace(/\/$/u, ''))
        const f = candidates.find(u => useNamed ? u.includes(domain) && !u.includes('cloudflare.com/') : /[a-z0-9-]+\.trycloudflare\.com$/u.test(u))
        if (f !== undefined) { clearTimeout(t2); resolveRetry({ url: f, fatal: false, child: retry }) }
        if (/ERR|failed to (connect|establish|dial)/iu.test(text)) { clearTimeout(t2); resolveRetry({ url: '', fatal: true, child: retry }) }
      }
      retry.stdout?.on('data', onD); retry.stderr?.on('data', onD)
      retry.on('exit', () => resolveRetry({ url: '', fatal: true, child: retry }))
    })
    return result
  })
  if (captured.fatal || captured.url === '') err('TUNNEL_FAILED', 'Cloudflare 隧道启动失败（QUIC/网络被拦截）', '检查网络能否访问 Cloudflare；公司网络可能拦截；可显式指定 --protocol http2 重试')
  progress('tunnel', `${t('tunnelReady')}: ${captured.url}`)
  return { url: captured.url, fatal: false, child: captured.child }
}

// ---------------------------------------------------------------------------
// Relay (loopback) child process
// ---------------------------------------------------------------------------
async function startRelay(port: number, token: string, allowedHost: string): Promise<ChildProcess> {
  progress('relay', t('startRelay'))
  const relayBin = join(projectRoot, 'packages', 'remote-relay', 'lib', 'bin.js')
  const child = spawn(process.execPath, [relayBin], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSHPILOT_RELAY_HOST: '127.0.0.1',
      DSHPILOT_RELAY_PORT: String(port),
      DSHPILOT_RELAY_TOKEN: token,
      // Allow the phone web PWA (any browser origin) and the tunnel host.
      DSHPILOT_RELAY_ALLOWED_ORIGINS: '*',
      DSHPILOT_RELAY_ALLOWED_HOSTS: allowedHost,
    },
  })
  const ready = await new Promise<boolean>((resolveRelay) => {
    const timer = setTimeout(() => resolveRelay(false), 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (text.includes('dshpilotRelay')) { clearTimeout(timer); resolveRelay(true) }
    })
    child.on('exit', () => { clearTimeout(timer); resolveRelay(false) })
  })
  if (!ready) err('RELAY_FAILED', '本地盲中继启动失败', '查看中继进程日志；确认 8787 端口未被占用')
  progress('relay', t('relayReady'))
  return child
}

// ---------------------------------------------------------------------------
// Self-test: complete a relay handshake through the tunnel URL
// ---------------------------------------------------------------------------
function testRelay(tunnelUrl: string, channelId: string, token: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveTest) => {
    const wsUrl = relayWebSocketUrl({ url: tunnelUrl.replace(/^https:/u, 'wss:'), channelId, role: 'client', token })
    const ws = new WebSocket(wsUrl, `dshpilot-relay-v1.${token}`)
    const timer = setTimeout(() => { ws.terminate(); resolveTest({ ok: false, detail: 'relay handshake timed out (15s)' }) }, 15_000)
    let nonce = ''
    let last = ''
    ws.on('open', () => ws.send(relayHello({ url: tunnelUrl.replace(/^https:/u, 'wss:'), channelId, role: 'client', token })))
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const value = JSON.parse(data.toString())
        last = value.type ?? last
        if (value.type === 'ready' && value.nonce) { nonce = value.nonce; ws.send(relayAuthenticate({ url: tunnelUrl.replace(/^https:/u, 'wss:'), channelId, role: 'client', token }, nonce)) }
        else if (value.type === 'authenticated') { clearTimeout(timer); ws.close(); resolveTest({ ok: true, detail: 'WAN relay reachable' }) }
      } catch { /* ignore */ }
    })
    ws.on('error', (error: unknown) => { clearTimeout(timer); resolveTest({ ok: false, detail: `relay socket error: ${error instanceof Error ? error.message : String(error)}` }) })
    ws.on('close', (code: number, reason: Buffer) => { clearTimeout(timer); resolveTest({ ok: false, detail: `relay closed before auth: code=${code} last=${last} reason=${reason.toString('utf8') || 'none'}` }) })
  })
}

// ---------------------------------------------------------------------------
// Harness control plane (reuses materialize + spawn from remote:serve)
// ---------------------------------------------------------------------------
interface SetupResult {
  tunnelUrl: string
  lanEndpoint?: string
  relay: { url: string; channelId: string; token: string; encryptionKey: string }
  pairingOffer: unknown
  checks: Array<{ name: string; ok: boolean; detail: string }>
}

async function materializeLocalPackages(home: string): Promise<void> {
  const destination = join(home, 'profiles', 'node_modules', '@dshpilot')
  await mkdir(destination, { recursive: true })
  for (const packageName of ['control-contracts', 'desktop-host', 'dsh-plugin-desktop', 'dsh-client-desktop', 'remote-daemon', 'remote-client', 'remote-relay']) {
    const source = join(projectRoot, 'packages', packageName)
    const target = join(destination, packageName)
    try { await access(join(source, 'lib', 'index.js')); await rm(target, { recursive: true, force: true }); await cp(source, target, { recursive: true }) } catch { /* packaged runtimes already contain the package graph */ }
  }
}

async function startHarness(home: string, env: NodeResourceEnv): Promise<{ child: ChildProcess; offerPromise: Promise<unknown> }> {
  progress('control', t('startControl'))
  const dataRoot = dirname(home)
  const patchPath = join(dataRoot, 'dshpilot.patch.yml')
  try { await access(patchPath) } catch { await writeFile(patchPath, "# DSHPilot self-hosted Harness integration\n- insert:\n    - id: dshpilot-host\n      name: '@dshpilot/dsh-plugin-desktop'\n      inject: [webServer, apiProxy, tools, loader]\n    - id: dshpilot-client\n      name: '@dshpilot/dsh-client-desktop'\n", { encoding: 'utf8', mode: 0o600 }) }
  await materializeLocalPackages(home)
  const node = process.execPath
  const script = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const args = [script, 'web', '--patch', patchPath, '--host', env.DSHPILOT_REMOTE_HOST ?? '127.0.0.1', '--port', env.DSHPILOT_REMOTE_PORT ?? '0']
  const child = spawn(node, args, { cwd: harnessRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...env } })
  const offerPromise = new Promise<unknown>((resolveOffer, rejectOffer) => {
    let buffer = ''
    const timer = setTimeout(() => rejectOffer(new Error('pairing-offer-timeout')), 45_000)
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8'); buffer += text
      const line = text.split(/\r?\n/).find(l => l.includes('dshpilotPairingOffer'))
      if (line !== undefined) {
        try { const json = JSON.parse(line); if (json.dshpilotPairingOffer !== undefined) { clearTimeout(timer); resolveOffer(json.dshpilotPairingOffer); return } } catch { /* keep scanning */ }
      }
      if (/dshpilotRemote: 'ready'/u.test(buffer) || buffer.includes('dshpilotRemote')) { /* control plane up, waiting for offer */ }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('exit', () => { if (!buffer.includes('dshpilotPairingOffer')) { clearTimeout(timer); rejectOffer(new Error('harness-exited')) } })
  })
  return { child, offerPromise }
}

type NodeResourceEnv = Record<string, string>

// ---------------------------------------------------------------------------
// LAN-direct (optional, experimental): self-signed cert + bind to LAN IP
// ---------------------------------------------------------------------------
async function setupLan(): Promise<{ lanEndpoint?: string; host?: string; port?: string; tlsKey?: string; tlsCert?: string; allowedHosts?: string }> {
  if (!flag('--lan')) return {}
  const os = await import('node:os')
  const ifaces = os.networkInterfaces()
  let lanIp: string | undefined
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) { lanIp = info.address; break }
    }
    if (lanIp !== undefined) break
  }
  if (lanIp === undefined) return {}
  const port = '57274'
  const dir = join(tmpdir(), 'dshpilot-lan-tls')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const keyPath = join(dir, 'key.pem'); const certPath = join(dir, 'cert.pem')
  const openssl = await which('openssl')
  if (openssl === undefined) return {}
  const r = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '365', '-subj', '/CN=dshpilot', '-addext', `subjectAltName=IP:${lanIp}`], { capture: true }).catch(() => ({ code: 1, stdout: '', stderr: '' }))
  if (r.code !== 0) return {}
  return { lanEndpoint: `https://${lanIp}:${port}`, host: lanIp, port, tlsKey: keyPath, tlsCert: certPath, allowedHosts: lanIp }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  progress('init', t('start'))
  // Pre-checks -----------------------------------------------------------------
  progress('check', t('checkCloudflared'))
  const cfPath = await which('cloudflared')
  if (cfPath === undefined) err('CLOUDFLARED_MISSING', '未安装 cloudflared', 'macOS: brew install cloudflared  |  Linux: 见 https://developers.cloudflare.com/cloudflared/  |  Windows: winget install Cloudflare.cloudflared')
  const ver = await run('cloudflared', ['version'], { capture: true })
  progress('check', `${t('cloudflaredVersion')}: ${ver.stdout.trim().split('\n')[0] ?? 'unknown'}`)

  const relayPort = Number(arg('--port', '8787'))
  progress('check', t('checkPort'))
  if (!(await portFree(relayPort))) err('RELAY_PORT_IN_USE', `本地端口 ${relayPort} 已被占用`, `释放 ${relayPort} 后重试，或用 --port 指定其他端口`)

  if (flag('--domain') && flag('--tunnel')) { progress('check', t('checkLogin')); }

  // Tunnel → host known before relay so we can allowlist it -------------------
  const { url: tunnelUrl, child: tunnelChild } = await startTunnel(relayPort)
  const tunnelHost = new URL(tunnelUrl).host

  // Credentials ----------------------------------------------------------------
  const channelId = randomBytes(32).toString('base64url')
  const token = randomBytes(32).toString('base64url')
  const encryptionKey = randomBytes(32).toString('base64url')

  const relayChild = await startRelay(relayPort, token, tunnelHost)

  // LAN-direct (optional) ------------------------------------------------------
  const lan = await setupLan()

  // Harness control plane ------------------------------------------------------
  const dataRoot = resolve(arg('--data', join(tmpdir(), 'dshpilot-remote-data')))
  const home = join(dataRoot, 'dsh-home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const harnessEnv: NodeResourceEnv = {
    DSHPILOT_REMOTE_CONTROL: '1',
    DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING: '1',
    DSHPILOT_REMOTE_PRINT_PAIRING: '1',
    DSHPILOT_REMOTE_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    DSHPILOT_REMOTE_RELAY_ADVERTISED_URL: tunnelUrl.replace(/^https:/u, 'wss:'),
    DSHPILOT_REMOTE_RELAY_TOKEN: token,
    DSHPILOT_REMOTE_RELAY_CHANNEL: channelId,
    DSHPILOT_REMOTE_RELAY_KEY: encryptionKey,
    DSHPILOT_REMOTE_LAN_ENDPOINT: lan.lanEndpoint ?? '',
    ...(lan.host !== undefined ? { DSHPILOT_REMOTE_HOST: lan.host, DSHPILOT_REMOTE_PORT: lan.port!, DSHPILOT_REMOTE_TLS_KEY: lan.tlsKey!, DSHPILOT_REMOTE_TLS_CERT: lan.tlsCert!, DSHPILOT_REMOTE_ALLOWED_HOSTS: lan.allowedHosts! } : {}),
  }
  const { child: harnessChild, offerPromise } = await startHarness(home, harnessEnv)
  progress('control', t('controlReady'))

  // Self-test ------------------------------------------------------------------
  progress('selftest', t('selfTest'))
  const relayResult = await testRelay(tunnelUrl, channelId, token)
  const relayOk = relayResult.ok
  const checks = [{ name: 'tunnel', ok: true, detail: tunnelUrl }, { name: 'relay-handshake', ok: relayOk, detail: relayResult.detail }]
  if (!relayOk) emit({ type: 'error', ok: false, code: 'RELAY_HANDSHAKE_FAILED', message: '外网中继握手失败：手机无法经隧道连入', hint: `细节：${relayResult.detail}；确认 cloudflared 隧道未退出、中继在运行、防火墙未拦截 WS`, fatal: false })

  let pairingOffer: unknown
  try { pairingOffer = await offerPromise } catch { emit({ type: 'error', ok: false, code: 'PAIRING_OFFER_TIMEOUT', message: '未捕获到 pairing offer（控制面可能未就绪）', hint: '查看 Harness 日志；确认 dsh-plugin-desktop 已注入并启用 remote', fatal: false }) }

  const setup: SetupResult = {
    tunnelUrl,
    lanEndpoint: lan.lanEndpoint,
    relay: { url: tunnelUrl.replace(/^https:/u, 'wss:'), channelId, token, encryptionKey },
    pairingOffer,
    checks,
  }
  emit({ type: 'result', ok: true, setup })
  progress('done', t('done'))
  progress('stay', t('staying'))

  // Keep the stack alive; clean up on signal.
  const children = [tunnelChild, relayChild, harnessChild]
  const stop = (): void => { for (const c of children) { try { c.kill('SIGTERM') } catch { /* ignore */ } } }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  await new Promise<void>(() => { /* run until killed */ })
}

void main().catch((error: unknown) => { emit({ type: 'error', ok: false, code: 'FATAL', message: error instanceof Error ? error.message : String(error), hint: '', fatal: true }); process.exitCode = 1 })
