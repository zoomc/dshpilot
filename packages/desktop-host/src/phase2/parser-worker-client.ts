import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateDocumentManifest, type DocumentAttachmentManifest, type DocumentProvider } from './attachments.js'
import type { DocumentInspection, DocumentReadResult, DocumentSearchResult, SpreadsheetSheetInfo } from './documents.js'

const execFile = promisify(execFileCallback)
const PROTOCOL_VERSION = 1 as const
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 250

export type ParserOperation = 'inspect' | 'read' | 'search' | 'spreadsheetSheetInfo' | 'spreadsheetReadRange' | 'presentationSlide'

export interface ParserWorkerRequest {
  protocolVersion: typeof PROTOCOL_VERSION
  inputPath: string
  manifest: DocumentAttachmentManifest
  operation: ParserOperation
  maxOutputCharacters: number
  options?: { offset?: number; limit?: number; sheet?: string | number; range?: string; slide?: number; maxMatches?: number }
  query?: string
  sheet?: string | number
  range?: string
  slide?: number
}

export interface ParserWorkerCommand {
  executable: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
}

export interface ParserWorkerOptions {
  /** Hard wall-clock limit. The child is killed, not merely abandoned. */
  timeoutMs?: number
  /** Parent directory for private 0700 request directories. */
  tempRoot?: string
  /** Internal test seam for a deliberately hanging/crashing child. */
  workerCommand?: ParserWorkerCommand
  maxResponseBytes?: number
  killGraceMs?: number
}

export class ParserWorkerError extends Error {
  constructor(readonly code: 'timeout' | 'cancelled' | 'crashed' | 'failed' | 'protocol', message: string, readonly pid?: number) {
    super(message)
    this.name = 'ParserWorkerError'
  }
}

function workerCommand(): ParserWorkerCommand {
  const compiled = fileURLToPath(new URL('./parser-worker.js', import.meta.url))
  if (requireFile(compiled)) return { executable: process.execPath, args: [compiled] }

  // Vitest executes the TypeScript source tree directly. The production build
  // always takes the compiled branch above, so tsx is never a runtime asset.
  const source = fileURLToPath(new URL('./parser-worker.ts', import.meta.url))
  if (requireFile(source)) {
    const loader = createRequire(import.meta.url).resolve('tsx/esm')
    return { executable: process.execPath, args: ['--import', loader, source] }
  }
  throw new Error('parser worker entrypoint is missing')
}

function requireFile(path: string): boolean {
  try { return existsSync(path) } catch { return false }
}

function childEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  // The parser is pure and must not inherit provider credentials or arbitrary
  // application variables. Keep only what Node needs to start on each OS.
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot
    if (process.env.ComSpec) environment.ComSpec = process.env.ComSpec
  }
  return { ...environment, ...extra }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      await execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      // Fall through to ChildProcess.kill when taskkill is unavailable or the
      // process has already exited.
    }
  } else {
    try {
      // The child is detached on Unix, therefore its process group contains
      // the parser and any native helper it may have launched.
      process.kill(-pid, signal)
      return
    } catch {
      // Fall through to killing the direct child if the group disappeared.
    }
  }
  try { child.kill(signal) } catch { /* already exited */ }
}

function childClosed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', (code, signal) => done({ code, signal }))
  })
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateTimeout(value: number | undefined, name: string, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result <= 0 || result > 10 * 60_000) throw new RangeError(`${name} must be between 1 and 600000 milliseconds`)
  return Math.floor(result)
}

function responseError(output: string, fallback: string): string {
  try {
    const parsed = JSON.parse(output) as { ok?: boolean; error?: { message?: string } }
    if (parsed.ok === false && typeof parsed.error?.message === 'string') return parsed.error.message
  } catch { /* handled by the caller as a protocol/crash error */ }
  return fallback
}

/** Execute one parser request in a killable child process. */
export function runParserWorker<T>(
  provider: DocumentProvider,
  manifest: DocumentAttachmentManifest,
  payload: Omit<ParserWorkerRequest, 'protocolVersion' | 'inputPath' | 'manifest'>,
  options: ParserWorkerOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  return (async () => {
    validateDocumentManifest(manifest)
    signal?.throwIfAborted()
    const timeoutMs = validateTimeout(options.timeoutMs, 'parser timeout', DEFAULT_TIMEOUT_MS)
    const killGraceMs = validateTimeout(options.killGraceMs, 'parser kill grace', DEFAULT_KILL_GRACE_MS)
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) throw new RangeError('parser max response size is invalid')

    const data = await provider.read(manifest.attachmentId, signal)
    signal?.throwIfAborted()
    if (data.byteLength !== manifest.bytes) throw new ParserWorkerError('failed', 'document provider returned a size different from its manifest')

    const requestRoot = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'dshpilot-parser-'))
    await chmod(requestRoot, 0o700)
    const inputPath = join(requestRoot, 'input.bin')
    await writeFile(inputPath, data, { mode: 0o600 })
    await chmod(inputPath, 0o600)

    const command = options.workerCommand ?? workerCommand()
    const request: ParserWorkerRequest = { protocolVersion: PROTOCOL_VERSION, inputPath, manifest, ...payload }
    const child = spawn(command.executable, [...(command.args ?? [])], {
      cwd: requestRoot,
      detached: process.platform !== 'win32',
      env: childEnvironment(command.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let terminating = false
    let terminationError: ParserWorkerError | undefined
    let timer: NodeJS.Timeout | undefined
    let abortHandler: (() => void) | undefined

    try {
      const closePromise = childClosed(child)
      const result = await new Promise<T>((resolve, reject) => {
        const settleReject = (error: unknown) => reject(error)
        const terminate = async (error: ParserWorkerError) => {
          if (terminating) return
          terminating = true
          terminationError = error
          await killProcessTree(child, 'SIGTERM')
          const closed = await Promise.race([closePromise.then(() => true, () => true), delay(killGraceMs).then(() => false)])
          if (!closed) {
            await killProcessTree(child, 'SIGKILL')
            await Promise.race([closePromise.then(() => true, () => true), delay(1_000)])
          }
          settleReject(error)
        }

        const onData = (chunk: Buffer, target: 'stdout' | 'stderr') => {
          if (target === 'stdout') stdout = Buffer.concat([stdout, chunk])
          else stderr = Buffer.concat([stderr, chunk])
          if (stdout.byteLength + stderr.byteLength > maxResponseBytes) {
            void terminate(new ParserWorkerError('failed', 'parser worker response exceeded the safety limit', child.pid))
          }
        }
        child.stdout?.on('data', chunk => onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), 'stdout'))
        child.stderr?.on('data', chunk => onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), 'stderr'))
        child.once('error', error => {
          if (!terminating) settleReject(new ParserWorkerError('crashed', `parser worker failed to start: ${normalizeError(error)}`, child.pid))
        })
        child.once('close', (code, exitSignal) => {
          if (terminating) return
          if (code !== 0 || exitSignal !== null) {
            settleReject(new ParserWorkerError('crashed', responseError(stdout.toString('utf8'), `parser worker exited with ${exitSignal ?? `code ${code}`}${stderr.length > 0 ? `: ${stderr.toString('utf8').trim()}` : ''}`), child.pid))
            return
          }
          try {
            const response = JSON.parse(stdout.toString('utf8')) as { ok: boolean; value?: T; error?: { message?: string } }
            if (response.ok !== true) throw new ParserWorkerError('failed', response.error?.message ?? 'parser worker rejected the request', child.pid)
            resolve(response.value as T)
          } catch (error) {
            settleReject(error instanceof ParserWorkerError ? error : new ParserWorkerError('protocol', `invalid parser worker response: ${normalizeError(error)}`, child.pid))
          }
        })

        timer = setTimeout(() => { void terminate(new ParserWorkerError('timeout', `parser worker exceeded ${timeoutMs} milliseconds`, child.pid)) }, timeoutMs)
        abortHandler = () => { void terminate(new ParserWorkerError('cancelled', 'parser worker was cancelled', child.pid)) }
        if (signal?.aborted) abortHandler()
        else signal?.addEventListener('abort', abortHandler, { once: true })

        try { child.stdin?.end(`${JSON.stringify(request)}\n`) } catch (error) { settleReject(new ParserWorkerError('crashed', `failed to send parser request: ${normalizeError(error)}`, child.pid)) }
      })
      return result
    } finally {
      if (timer) clearTimeout(timer)
      if (abortHandler) signal?.removeEventListener('abort', abortHandler)
      // If a caller-side exception happened before the close handler ran,
      // never leave a parser child alive or its input directory behind.
      if (!terminating && child.exitCode === null && child.signalCode === null) {
        await killProcessTree(child, 'SIGKILL')
        await Promise.race([childClosed(child).catch(() => undefined), delay(1_000)])
      }
      await rm(requestRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      void terminationError
    }
  })()
}
