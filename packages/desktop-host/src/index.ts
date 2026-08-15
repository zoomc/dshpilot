import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface RuntimeManifest {
  schemaVersion: 1
  channel: 'tested'
  runtimeVersion: string
  upstream: { repository: string; ref: string; sha: string; version: string }
  node: { version: string; platform: string; arch: string }
  artifact: { url: string; size: number; sha256: string; signature: string }
  manifestSignature?: { algorithm: 'Ed25519'; keyId: string; value: string }
  generatedAt: string
}

export type SupervisorState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'restarting' | 'failed'

export interface SupervisorStatus {
  state: SupervisorState
  url?: string
  pid?: number
  restartCount: number
  lastError?: string
}

export const APP_DATA_DIRECTORIES = [
  'runtime', 'runtime/versions', 'runtime/staging', 'dsh-home', 'desktop', 'logs', 'update',
] as const

export interface AppDataPaths {
  root: string; runtime: string; versions: string; staging: string; dshHome: string
  desktop: string; logs: string; update: string; current: string; previous: string
}

export function resolveAppDataPaths(root: string): AppDataPaths {
  const appData = resolve(root)
  const runtime = join(appData, 'runtime')
  return {
    root: appData, runtime, versions: join(runtime, 'versions'), staging: join(runtime, 'staging'),
    dshHome: join(appData, 'dsh-home'), desktop: join(appData, 'desktop'), logs: join(appData, 'logs'),
    update: join(appData, 'update'), current: join(runtime, 'current.json'), previous: join(runtime, 'previous.json'),
  }
}

export async function ensureAppData(paths: AppDataPaths): Promise<void> {
  await Promise.all([
    paths.root, paths.runtime, paths.versions, paths.staging, paths.dshHome, paths.desktop, paths.logs, paths.update,
  ].map(path => mkdir(path, { recursive: true })))
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
  } catch { return false }
}

export function parseReadinessUrl(line: string): string | undefined {
  const candidate = line.match(/https?:\/\/[^\s),;]+/i)?.[0]
  return candidate !== undefined && isLoopbackUrl(candidate) ? candidate : undefined
}

export function validateRuntimeManifest(value: unknown): RuntimeManifest {
  if (typeof value !== 'object' || value === null) throw new Error('runtime manifest must be an object')
  const manifest = value as Partial<RuntimeManifest>
  if (manifest.schemaVersion !== 1 || manifest.channel !== 'tested') throw new Error('unsupported runtime manifest')
  if (!manifest.runtimeVersion || !manifest.upstream || !manifest.node || !manifest.artifact) throw new Error('runtime manifest is incomplete')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(manifest.runtimeVersion)) throw new Error('runtimeVersion is invalid')
  if (typeof manifest.upstream.sha !== 'string' || !/^[a-f0-9]{40,64}$/iu.test(manifest.upstream.sha)) throw new Error('runtime upstream sha is invalid')
  if (typeof manifest.node.version !== 'string' || typeof manifest.node.platform !== 'string' || typeof manifest.node.arch !== 'string') throw new Error('runtime node metadata is invalid')
  if (!Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 0) throw new Error('runtime artifact size is invalid')
  if (!/^[a-f0-9]{64}$/i.test(manifest.artifact.sha256)) throw new Error('runtime artifact sha256 is invalid')
  if (!manifest.artifact.signature || !manifest.generatedAt || Number.isNaN(Date.parse(manifest.generatedAt))) throw new Error('runtime manifest metadata is invalid')
  if (manifest.manifestSignature !== undefined && (manifest.manifestSignature.algorithm !== 'Ed25519' || !manifest.manifestSignature.keyId || !manifest.manifestSignature.value)) throw new Error('runtime manifest signature metadata is invalid')
  return manifest as RuntimeManifest
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'manifestSignature').sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalValue(entry)]))
}

export function runtimeManifestSigningPayload(manifest: RuntimeManifest): string {
  validateRuntimeManifest(manifest)
  return JSON.stringify(canonicalValue(manifest))
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  try { await rename(temporary, path) }
  catch (error) {
    // Windows does not replace an existing destination with rename(). Keep the
    // operation recoverable and only remove the exact pointer file after the
    // replacement has been staged.
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    await rm(path, { force: true }); await rename(temporary, path)
  }
}

export class RuntimePointers {
  constructor(readonly paths: AppDataPaths) {}
  async current(): Promise<RuntimeManifest | undefined> { await this.recoverInterruptedTransaction(); return this.readOptional(this.paths.current) }
  async previous(): Promise<RuntimeManifest | undefined> { await this.recoverInterruptedTransaction(); return this.readOptional(this.paths.previous) }
  async promote(manifest: RuntimeManifest): Promise<void> {
    validateRuntimeManifest(manifest)
    await this.recoverInterruptedTransaction()
    const current = await this.readOptional(this.paths.current)
    const previous = await this.readOptional(this.paths.previous)
    await this.writeTransaction({ current, previous })
    try {
      if (current) await atomicWrite(this.paths.previous, `${JSON.stringify(current, null, 2)}\n`)
      else await rm(this.paths.previous, { force: true })
      await atomicWrite(this.paths.current, `${JSON.stringify(manifest, null, 2)}\n`)
      await rm(this.transactionPath(), { force: true })
    } catch (error) { await this.recoverInterruptedTransaction(); throw error }
  }
  async rollback(): Promise<RuntimeManifest> {
    await this.recoverInterruptedTransaction()
    const previous = await this.readOptional(this.paths.previous)
    if (!previous) throw new Error('no previous runtime is available')
    const current = await this.readOptional(this.paths.current)
    await this.writeTransaction({ current, previous })
    try {
      if (current) await atomicWrite(this.paths.previous, `${JSON.stringify(current, null, 2)}\n`)
      else await rm(this.paths.previous, { force: true })
      await atomicWrite(this.paths.current, `${JSON.stringify(previous, null, 2)}\n`)
      await rm(this.transactionPath(), { force: true })
    } catch (error) { await this.recoverInterruptedTransaction(); throw error }
    return previous
  }
  private transactionPath(): string { return join(this.paths.runtime, 'pointers.transaction.json') }
  private async writeTransaction(value: { current?: RuntimeManifest; previous?: RuntimeManifest }): Promise<void> { await atomicWrite(this.transactionPath(), `${JSON.stringify(value)}\n`) }
  private async recoverInterruptedTransaction(): Promise<void> {
    let value: { current?: RuntimeManifest; previous?: RuntimeManifest }
    try { value = JSON.parse(await readFile(this.transactionPath(), 'utf8')) as { current?: RuntimeManifest; previous?: RuntimeManifest } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (value.current) await atomicWrite(this.paths.current, `${JSON.stringify(value.current, null, 2)}\n`); else await rm(this.paths.current, { force: true })
    if (value.previous) await atomicWrite(this.paths.previous, `${JSON.stringify(value.previous, null, 2)}\n`); else await rm(this.paths.previous, { force: true })
    await rm(this.transactionPath(), { force: true })
  }
  private async readOptional(path: string): Promise<RuntimeManifest | undefined> {
    try { return validateRuntimeManifest(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function publicKeyFromManifest(value: string): ReturnType<typeof createPublicKey> {
  if (value.includes('BEGIN PUBLIC KEY')) return createPublicKey(value)
  const raw = Buffer.from(value, 'base64')
  if (raw.length !== 32) throw new Error('Ed25519 public key must be PEM or base64 encoded 32-byte raw key')
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
}

export function verifyRuntimeManifestSignature(manifest: RuntimeManifest, publicKey: string, allowUnsignedLocal = false): void {
  validateRuntimeManifest(manifest)
  if (manifest.manifestSignature === undefined) {
    if (!allowUnsignedLocal) throw new Error('runtime manifest is unsigned')
    return
  }
  if (!verifySignature(null, Buffer.from(runtimeManifestSigningPayload(manifest)), publicKeyFromManifest(publicKey), Buffer.from(manifest.manifestSignature.value, 'base64'))) throw new Error('runtime manifest signature mismatch')
}

export async function verifyRuntimeArtifact(path: string, manifest: RuntimeManifest, publicKey: string, allowUnsignedLocal = false, requireManifestSignature = false): Promise<void> {
  validateRuntimeManifest(manifest)
  if (requireManifestSignature) verifyRuntimeManifestSignature(manifest, publicKey, allowUnsignedLocal)
  if ((await stat(path)).size !== manifest.artifact.size) throw new Error('runtime artifact size mismatch')
  if ((await sha256File(path)).toLowerCase() !== manifest.artifact.sha256.toLowerCase()) throw new Error('runtime artifact checksum mismatch')
  if (manifest.artifact.signature === 'UNSIGNED-LOCAL') {
    if (!allowUnsignedLocal) throw new Error('unsigned local runtime is not accepted')
    return
  }
  const signature = Buffer.from(manifest.artifact.signature, 'base64')
  if (!verifySignature(null, await readFile(path), publicKeyFromManifest(publicKey), signature)) throw new Error('runtime artifact signature mismatch')
}

export interface SupervisorCoreOptions { maxRestarts?: number; maxBackoffMs?: number; sleep?: (milliseconds: number) => Promise<void> }

export class SupervisorCore {
  private readonly maxRestarts: number
  private readonly maxBackoffMs: number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private statusValue: SupervisorStatus = { state: 'idle', restartCount: 0 }
  constructor(options: SupervisorCoreOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? 5
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)))
  }
  get status(): SupervisorStatus { return { ...this.statusValue } }
  starting(): void { this.statusValue = { state: 'starting', restartCount: this.statusValue.restartCount } }
  ready(url: string, pid?: number): void { this.statusValue = { state: 'ready', restartCount: this.statusValue.restartCount, url, pid } }
  stopping(): void { this.statusValue = { ...this.statusValue, state: 'stopping' } }
  stopped(): void { this.statusValue = { state: 'stopped', restartCount: 0 } }
  async unexpectedExit(error: Error | string): Promise<boolean> {
    const restartCount = this.statusValue.restartCount + 1
    if (restartCount > this.maxRestarts) {
      this.statusValue = { state: 'failed', restartCount, lastError: String(error) }; return false
    }
    this.statusValue = { state: 'restarting', restartCount, lastError: String(error) }
    await this.sleep(Math.min(1000 * (2 ** (restartCount - 1)), this.maxBackoffMs)); return true
  }
}

export interface RuntimeInstallOptions {
  publicKey: string
  /** Base URL for manifests that use a relative artifact URL. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  extract: (archivePath: string, stagingDirectory: string) => Promise<void>
  smoke: (stagingDirectory: string) => Promise<void>
  signal?: AbortSignal
  allowUnsignedLocal?: boolean
  requireManifestSignature?: boolean
  maxDownloadBytes?: number
}

export function validateArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '')
    if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
      || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
      throw new Error(`runtime archive path traversal: ${entry}`)
    }
  }
}

export async function downloadAndInstallRuntime(manifest: RuntimeManifest, pointers: RuntimePointers, options: RuntimeInstallOptions): Promise<void> {
  validateRuntimeManifest(manifest)
  const artifactUrl = options.baseUrl === undefined ? manifest.artifact.url : new URL(manifest.artifact.url, options.baseUrl).toString()
  const response = await (options.fetchImpl ?? fetch)(artifactUrl, { signal: options.signal })
  if (!response.ok || response.body === null) throw new Error(`runtime download failed: HTTP ${response.status}`)
  await ensureAppData(pointers.paths)
  const archivePath = join(pointers.paths.staging, `${manifest.runtimeVersion}.${process.pid}.archive`)
  const stagingDirectory = join(pointers.paths.staging, `${manifest.runtimeVersion}.${process.pid}`)
  const journalPath = join(pointers.paths.update, 'runtime-update.json')
  const journal = async (phase: string, error?: unknown): Promise<void> => {
    await atomicWrite(journalPath, `${JSON.stringify({ runtimeVersion: manifest.runtimeVersion, phase, at: new Date().toISOString(), ...(error === undefined ? {} : { error: String(error) }) }, null, 2)}\n`)
  }
  await journal('downloading')
  try {
    const handle = await open(archivePath, 'w', 0o600)
    let bytes = 0
    try {
      const reader = response.body.getReader()
      while (true) {
        options.signal?.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > manifest.artifact.size || bytes > (options.maxDownloadBytes ?? manifest.artifact.size)) throw new Error('runtime download exceeds the manifest size limit')
        await handle.write(Buffer.from(chunk.value))
      }
    } finally { await handle.close() }
    if (bytes !== manifest.artifact.size) throw new Error('runtime download size mismatch')
    await verifyRuntimeArtifact(archivePath, manifest, options.publicKey, options.allowUnsignedLocal, options.requireManifestSignature)
    await journal('verified')
    await rm(stagingDirectory, { recursive: true, force: true }); await mkdir(stagingDirectory, { recursive: true })
    await options.extract(archivePath, stagingDirectory); await options.smoke(stagingDirectory)
    const runtimeDirectory = join(pointers.paths.versions, manifest.runtimeVersion)
    // Runtime versions are immutable. A retry may reuse an already-installed
    // version, but it must never replace bytes behind an existing pointer.
    try {
      await stat(runtimeDirectory)
      await options.smoke(runtimeDirectory)
      await rm(stagingDirectory, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await rename(stagingDirectory, runtimeDirectory)
    }
    await journal('installed')
    await pointers.promote(manifest)
    await journal('promoted')
  } catch (error) {
    await journal('failed', error)
    throw error
  } finally {
    await rm(archivePath, { force: true }); await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export function defaultAppDataRoot(): string {
  if (process.env.DSHPILOT_APP_DATA !== undefined) return process.env.DSHPILOT_APP_DATA
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DSHPilot')
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DSHPilot')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'DSHPilot')
}
export function testAppDataRoot(): string { return join(tmpdir(), 'dshpilot-test-data') }

export * from './phase2/attachments.js'
export * from './phase2/mcp.js'
export * from './phase2/notifications.js'
export * from './phase2/tokens.js'
export * from './phase2/documents.js'
export * from './phase3.js'
