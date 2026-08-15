import { createHash } from 'node:crypto'
import { lstat, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { isPathInside, validateDocumentManifest, type DocumentAttachmentManifest, type DocumentProvider } from './attachments.js'
import { InProcessDocumentTools, type DocumentInspection, type DocumentReadResult, type DocumentSearchResult, type SpreadsheetSheetInfo } from './documents.js'
import type { ParserOperation, ParserWorkerRequest } from './parser-worker-client.js'

class WorkerFileProvider implements DocumentProvider {
  readonly name = 'parser-worker'

  constructor(private readonly root: string, private readonly inputPath: string, private readonly manifest: DocumentAttachmentManifest) {}

  async addFile(_path: string): Promise<DocumentAttachmentManifest> { throw new Error('parser worker cannot add attachments') }

  async read(attachmentId: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    if (attachmentId !== this.manifest.attachmentId) throw new Error('parser worker attachment id mismatch')
    const path = resolve(this.inputPath)
    if (!isPathInside(this.root, path) || path === resolve(this.root)) throw new Error('parser worker input path escapes its request directory')
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('parser worker input is not a regular file')
    if (info.size !== this.manifest.bytes) throw new Error('parser worker input size does not match the manifest')
    const data = new Uint8Array(await readFile(path))
    signal?.throwIfAborted()
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== this.manifest.sha256) throw new Error('parser worker input checksum does not match the manifest')
    return data
  }
}

type WorkerResult = DocumentInspection | DocumentReadResult | DocumentSearchResult | SpreadsheetSheetInfo[]

async function execute(request: ParserWorkerRequest): Promise<WorkerResult> {
  if (request.protocolVersion !== 1) throw new Error('unsupported parser worker protocol')
  const manifest = validateDocumentManifest(request.manifest)
  if (!Number.isSafeInteger(request.maxOutputCharacters) || request.maxOutputCharacters < 1 || request.maxOutputCharacters > 2_000_000) throw new Error('parser output limit is invalid')
  const root = resolve(request.inputPath, '..')
  const path = resolve(request.inputPath)
  if (!isPathInside(root, path) || path === root) throw new Error('parser worker input path is invalid')
  const fileInfo = await stat(path)
  if (!fileInfo.isFile()) throw new Error('parser worker input is not a regular file')
  const tools = new InProcessDocumentTools(new WorkerFileProvider(root, path, manifest), request.maxOutputCharacters)
  const signal = new AbortController().signal
  switch (request.operation as ParserOperation) {
    case 'inspect': return tools.inspect(manifest, signal)
    case 'read': return tools.read(manifest, { ...(request.options ?? {}), signal })
    case 'search': return tools.search(manifest, request.query ?? '', { ...(request.options ?? {}), signal })
    case 'spreadsheetSheetInfo': return tools.spreadsheetSheetInfo(manifest, signal)
    case 'spreadsheetReadRange': return tools.spreadsheetReadRange(manifest, request.sheet ?? 0, request.range ?? 'A1:Z100', signal)
    case 'presentationSlide': return tools.presentationSlide(manifest, request.slide ?? 0, signal)
    default: throw new Error(`unsupported parser operation: ${String(request.operation)}`)
  }
}

async function main(): Promise<void> {
  const line = await new Promise<string>((resolveLine, reject) => {
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
    reader.once('line', value => { reader.close(); resolveLine(value) })
    reader.once('error', reject)
  })
  try {
    const value = await execute(JSON.parse(line) as ParserWorkerRequest)
    process.stdout.write(JSON.stringify({ ok: true, value }))
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }))
    process.exitCode = 1
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
