import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { downloadAndInstallRuntime, RuntimePointers, resolveAppDataPaths, validateArchiveEntries, validateRuntimeManifest } from './index.js'

const exec = promisify(execFile)
function arg(name: string): string | undefined { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1] }
function flag(name: string): boolean { return process.argv.includes(name) }

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const listing = (await exec('tar', ['-tzf', archivePath], { maxBuffer: 4 * 1024 * 1024 })).stdout.split('\n').filter(Boolean)
  validateArchiveEntries(listing)
  if (listing.some(entry => !entry.replaceAll('\\', '/').startsWith('runtime/'))) throw new Error('runtime archive must have a single runtime/ root')
  // Reject link entries before extraction. A post-extraction check alone is
  // too late: tar could follow an archive-provided symlink while creating a
  // later file. GNU tar and bsdtar both expose links in the verbose listing.
  const verboseListing = (await exec('tar', ['-tvzf', archivePath], { maxBuffer: 8 * 1024 * 1024 })).stdout.split('\n').filter(Boolean)
  if (verboseListing.some(line => /^[lh]/u.test(line) || /\s(?:->|link to)\s/u.test(line))) throw new Error('runtime archive must not contain symbolic or hard links')
  await exec('tar', ['-xzf', archivePath, '-C', destination], { maxBuffer: 1 * 1024 * 1024 })
  const extracted = join(destination, 'runtime'); const normalized = join(destination, '.normalized-runtime')
  await validateExtractedTree(extracted)
  await stat(extracted); await rm(normalized, { recursive: true, force: true }); await cp(extracted, normalized, { recursive: true })
  for (const entry of await readdir(normalized)) await rename(join(normalized, entry), join(destination, entry))
  await rm(extracted, { recursive: true, force: true }); await rm(normalized, { recursive: true, force: true })
}

async function validateExtractedTree(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  async function walk(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`runtime archive extracted a symbolic link: ${path}`)
    const canonical = await realpath(path)
    const escaped = relative(canonicalRoot, canonical)
    if (isAbsolute(escaped) || escaped === '..' || escaped.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`runtime archive extraction escaped destination: ${path}`)
    if (info.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry))
  }
  await walk(root)
}

async function smokeRuntime(root: string): Promise<void> {
  const node = join(root, process.platform === 'win32' ? 'node.exe' : 'node')
  const dsh = join(root, 'dsh', 'lib', 'bin.js')
  if (!(await stat(node).then(info => info.isFile()).catch(() => false)) || !(await stat(dsh).then(info => info.isFile()).catch(() => false))) throw new Error('runtime smoke failed: node or dsh entry is missing')
  const home = await mkdtemp(join(tmpdir(), 'dshpilot-runtime-smoke-'))
  try {
    const launchArgs = [dsh, 'web']
    if (await stat(join(root, 'dshpilot.patch.yml')).then(() => true).catch(() => false)) launchArgs.push('--patch', join(root, 'dshpilot.patch.yml'))
    launchArgs.push('--host', '127.0.0.1', '--port', '0')
    const child = spawn(node, launchArgs, { cwd: join(root, 'dsh'), env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const readiness = new Promise<string>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`runtime smoke readiness timed out: ${output.slice(-4_000)}`)), 30_000)
      const onData = (chunk: Buffer): void => {
        output += chunk.toString('utf8')
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0]
        if (url !== undefined && !settled) { settled = true; clearTimeout(timer); resolveReady(url) }
      }
      child.stdout.on('data', onData); child.stderr.on('data', onData)
      child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(error) } })
      child.once('exit', code => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error(`runtime smoke Harness exited with ${String(code)}: ${output.slice(-4_000)}`)) } })
    })
    try {
      const url = await readiness
      let healthy = false
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        try {
          const rootResponse = await fetch(url)
          const healthResponse = await fetch(`${url}/__dshpilot/health`)
          const health = await healthResponse.json() as { status?: string; apiReady?: boolean; webUiReady?: boolean }
          if (rootResponse.ok && (await rootResponse.text()).toLowerCase().includes('<!doctype html>') && healthResponse.ok && health.status === 'ready' && health.webUiReady === true && health.apiReady === true) { healthy = true; break }
        } catch { /* Harness is still starting */ }
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250))
      }
      if (!healthy) throw new Error(`runtime smoke health check failed: ${output.slice(-4_000)}`)
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>(resolveExit => { const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveExit() }, 5_000); child.once('exit', () => { clearTimeout(timer); resolveExit() }) })
    }
  } finally { await rm(home, { recursive: true, force: true }) }
}

async function withUpdateLock<T>(appData: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(appData, 'runtime', 'update.lock')
  await mkdir(join(appData, 'runtime'), { recursive: true })
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch { throw new Error('another Runtime update or rollback is already in progress') }
  try { return await action() } finally { await handle.close(); await rm(lockPath, { force: true }) }
}

async function main(): Promise<void> {
  const appData = resolve(arg('--app-data') ?? process.env.DSHPILOT_APP_DATA ?? './app-data'); const pointers = new RuntimePointers(resolveAppDataPaths(appData))
  await mkdir(appData, { recursive: true })
  await withUpdateLock(appData, async () => {
    if (flag('--rollback')) {
      const previous = await pointers.previous(); if (previous === undefined) throw new Error('no previous runtime is available')
      const previousRoot = join(resolveAppDataPaths(appData).versions, previous.runtimeVersion); await smokeRuntime(previousRoot)
      const manifest = await pointers.rollback();
      try { await smokeRuntime(join(resolveAppDataPaths(appData).versions, manifest.runtimeVersion)) }
      catch (error) { await pointers.rollback(); throw error }
      process.stdout.write(JSON.stringify({ ok: true, action: 'rollback', runtimeVersion: manifest.runtimeVersion }) + '\n'); return
    }
    const manifestPath = arg('--manifest'); if (manifestPath === undefined) throw new Error('--manifest is required')
    const manifest = validateRuntimeManifest(JSON.parse(await readFile(resolve(manifestPath), 'utf8')))
    const publicKeyPath = arg('--public-key'); const publicKey = publicKeyPath === undefined ? '' : await readFile(resolve(publicKeyPath), 'utf8')
    const allowUnsignedLocal = flag('--allow-unsigned') || process.env.DSHPILOT_ALLOW_UNSIGNED_RUNTIME === '1'
    await downloadAndInstallRuntime(manifest, pointers, { publicKey, baseUrl: arg('--base-url'), allowUnsignedLocal, requireManifestSignature: !allowUnsignedLocal, extract: extractArchive, smoke: smokeRuntime })
    process.stdout.write(JSON.stringify({ ok: true, action: 'install', runtimeVersion: manifest.runtimeVersion }) + '\n')
  })
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
