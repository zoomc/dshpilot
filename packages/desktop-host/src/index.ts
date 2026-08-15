import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface RuntimeManifest {
  schemaVersion: 1
  channel: 'tested'
  runtimeVersion: string
  upstream: { repository: string; ref: string; sha: string; version: string }
  node: { version: string; platform: string; arch: string }
  artifact: { url: string; size: number; sha256: string; signature: string }
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
  if (!Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 0) throw new Error('runtime artifact size is invalid')
  if (!/^[a-f0-9]{64}$/i.test(manifest.artifact.sha256)) throw new Error('runtime artifact sha256 is invalid')
  if (!manifest.artifact.signature || !manifest.generatedAt || Number.isNaN(Date.parse(manifest.generatedAt))) throw new Error('runtime manifest metadata is invalid')
  return manifest as RuntimeManifest
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

export class RuntimePointers {
  constructor(readonly paths: AppDataPaths) {}
  async current(): Promise<RuntimeManifest | undefined> { return this.readOptional(this.paths.current) }
  async previous(): Promise<RuntimeManifest | undefined> { return this.readOptional(this.paths.previous) }
  async promote(manifest: RuntimeManifest): Promise<void> {
    validateRuntimeManifest(manifest)
    const current = await this.current()
    if (current) await atomicWrite(this.paths.previous, `${JSON.stringify(current, null, 2)}\n`)
    await atomicWrite(this.paths.current, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  async rollback(): Promise<RuntimeManifest> {
    const previous = await this.previous()
    if (!previous) throw new Error('no previous runtime is available')
    const current = await this.current()
    if (current) await atomicWrite(this.paths.previous, `${JSON.stringify(current, null, 2)}\n`)
    await atomicWrite(this.paths.current, `${JSON.stringify(previous, null, 2)}\n`)
    return previous
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

export async function verifyRuntimeArtifact(path: string, manifest: RuntimeManifest, publicKey: string): Promise<void> {
  validateRuntimeManifest(manifest)
  if ((await stat(path)).size !== manifest.artifact.size) throw new Error('runtime artifact size mismatch')
  if ((await sha256File(path)).toLowerCase() !== manifest.artifact.sha256.toLowerCase()) throw new Error('runtime artifact checksum mismatch')
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
  fetchImpl?: typeof fetch
  extract: (archivePath: string, stagingDirectory: string) => Promise<void>
  smoke: (stagingDirectory: string) => Promise<void>
}

export async function downloadAndInstallRuntime(manifest: RuntimeManifest, pointers: RuntimePointers, options: RuntimeInstallOptions): Promise<void> {
  validateRuntimeManifest(manifest)
  const response = await (options.fetchImpl ?? fetch)(manifest.artifact.url)
  if (!response.ok || response.body === null) throw new Error(`runtime download failed: HTTP ${response.status}`)
  await ensureAppData(pointers.paths)
  const archivePath = join(pointers.paths.staging, `${manifest.runtimeVersion}.archive`)
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
  await verifyRuntimeArtifact(archivePath, manifest, options.publicKey)
  const stagingDirectory = join(pointers.paths.staging, manifest.runtimeVersion)
  await rm(stagingDirectory, { recursive: true, force: true }); await mkdir(stagingDirectory, { recursive: true })
  await options.extract(archivePath, stagingDirectory); await options.smoke(stagingDirectory)
  const runtimeDirectory = join(pointers.paths.versions, manifest.runtimeVersion)
  await rm(runtimeDirectory, { recursive: true, force: true }); await rename(stagingDirectory, runtimeDirectory)
  await pointers.promote(manifest); await rm(archivePath, { force: true })
}

export function defaultAppDataRoot(): string { return process.env.DSHPILOT_APP_DATA ?? join(homedir(), 'Library', 'Application Support', 'DSHPilot') }
export function testAppDataRoot(): string { return join(tmpdir(), 'dshpilot-test-data') }

export * from './phase2/attachments.js'
export * from './phase2/mcp.js'
export * from './phase2/notifications.js'
export * from './phase2/tokens.js'
