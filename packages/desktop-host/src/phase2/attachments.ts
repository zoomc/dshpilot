import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, normalize, relative, resolve } from 'node:path'

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'txt' | 'md' | 'json' | 'yaml' | 'xml'

export interface DocumentLimits {
  maxBytes: number
  maxArchiveEntries: number
  maxExpandedBytes: number
  maxCompressionRatio: number
}

export interface DocumentAttachmentManifest {
  attachmentId: string
  provider: string
  name: string
  kind: DocumentKind
  mediaType: string
  bytes: number
  sha256: string
  createdAt: string
  macros: false
  parser: string
  parserVersion: 1
  limits: Pick<DocumentLimits, 'maxBytes' | 'maxArchiveEntries' | 'maxExpandedBytes' | 'maxCompressionRatio'>
  extractionStatus: 'pending'
}

export interface DocumentProvider {
  readonly name: string
  addFile(path: string): Promise<DocumentAttachmentManifest>
  read(attachmentId: string, signal?: AbortSignal): Promise<Uint8Array>
}

export const DEFAULT_DOCUMENT_LIMITS: Readonly<DocumentLimits> = Object.freeze({
  maxBytes: 50 * 1024 * 1024,
  maxArchiveEntries: 2_000,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 200,
})

const EXTENSIONS: Record<string, { kind: DocumentKind; mediaType: string }> = {
  '.pdf': { kind: 'pdf', mediaType: 'application/pdf' },
  '.docx': { kind: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xlsx': { kind: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pptx': { kind: 'pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.csv': { kind: 'csv', mediaType: 'text/csv' },
  '.txt': { kind: 'txt', mediaType: 'text/plain' },
  '.md': { kind: 'md', mediaType: 'text/markdown' },
  '.json': { kind: 'json', mediaType: 'application/json' },
  '.yaml': { kind: 'yaml', mediaType: 'application/yaml' },
  '.yml': { kind: 'yaml', mediaType: 'application/yaml' },
  '.xml': { kind: 'xml', mediaType: 'application/xml' },
}

const ID_PATTERN = /^sha256:[a-f0-9]{64}$/u
const KIND_SET = new Set<DocumentKind>(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md', 'json', 'yaml', 'xml'])

function safeName(value: string): string {
  const leaf = basename(value.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 255)
  if (leaf === '' || leaf === '.' || leaf === '..') throw new Error('attachment name is invalid')
  return leaf
}

export function assertSafeRelativePath(value: string): string {
  if (value.includes('\u0000')) throw new Error('attachment path contains NUL')
  const normalized = normalize(value.replaceAll('\\', '/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error('attachment path traversal is not allowed')
  }
  return normalized
}

function metadataFor(path: string): { name: string; kind: DocumentKind; mediaType: string } {
  const name = safeName(path)
  const metadata = EXTENSIONS[extname(name).toLowerCase()]
  if (metadata === undefined) throw new Error(`unsupported document type: ${extname(name) || '(none)'}`)
  return { name, ...metadata }
}

export function validateDocumentManifest(value: unknown): DocumentAttachmentManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('document manifest must be an object')
  const manifest = value as Partial<DocumentAttachmentManifest>
  if (typeof manifest.attachmentId !== 'string' || !ID_PATTERN.test(manifest.attachmentId)) throw new Error('document attachment id is invalid')
  if (typeof manifest.provider !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/u.test(manifest.provider)) throw new Error('document provider is invalid')
  if (typeof manifest.name !== 'string' || safeName(manifest.name) !== manifest.name) throw new Error('document manifest name is invalid')
  if (typeof manifest.kind !== 'string' || !KIND_SET.has(manifest.kind)) throw new Error('document manifest kind is invalid')
  if (typeof manifest.mediaType !== 'string' || manifest.mediaType.length === 0 || manifest.mediaType.length > 200) throw new Error('document manifest media type is invalid')
  if (!Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) <= 0 || (manifest.bytes as number) > DEFAULT_DOCUMENT_LIMITS.maxBytes) throw new Error('document manifest byte count is invalid')
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256) || manifest.attachmentId !== `sha256:${manifest.sha256}`) throw new Error('document manifest checksum is invalid')
  if (manifest.macros !== false || typeof manifest.parser !== 'string' || manifest.parser.length === 0 || manifest.parserVersion !== 1 || manifest.extractionStatus !== 'pending') throw new Error('document manifest metadata is invalid')
  const limits = manifest.limits
  if (typeof limits !== 'object' || limits === null || !Number.isSafeInteger(limits.maxBytes) || !Number.isSafeInteger(limits.maxArchiveEntries) || !Number.isSafeInteger(limits.maxExpandedBytes) || !Number.isSafeInteger(limits.maxCompressionRatio)
    || limits.maxBytes <= 0 || limits.maxBytes > DEFAULT_DOCUMENT_LIMITS.maxBytes || limits.maxArchiveEntries < 1 || limits.maxArchiveEntries > 10_000 || limits.maxExpandedBytes < 1 || limits.maxExpandedBytes > 500 * 1024 * 1024 || limits.maxCompressionRatio < 1 || limits.maxCompressionRatio > 1_000) throw new Error('document manifest limits are invalid')
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('document manifest timestamp is invalid')
  return manifest as DocumentAttachmentManifest
}

function uint32(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24 >>> 0)
}

function uint16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8)
}

interface ArchiveStats { entries: number; expandedBytes: number; hasMacros: boolean }

/** Inspect Office ZIP metadata without extracting or executing any content. */
export function inspectOfficeArchive(data: Uint8Array, limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS): ArchiveStats {
  if (data.byteLength < 22) throw new Error('Office document archive is truncated')
  let eocd = -1
  const start = Math.max(0, data.byteLength - 65_557)
  for (let offset = data.byteLength - 22; offset >= start; offset -= 1) {
    if (uint32(data, offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('Office document archive directory is missing')
  const entries = uint16(data, eocd + 10)
  const directorySize = uint32(data, eocd + 12)
  const directoryOffset = uint32(data, eocd + 16)
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || entries > limits.maxArchiveEntries || directoryOffset + directorySize > data.byteLength) throw new Error('Office document archive exceeds safety limits (ZIP64 is not supported)')
  let offset = directoryOffset
  let expandedBytes = 0
  let hasMacros = false
  const decoder = new TextDecoder()
  for (let index = 0; index < entries; index += 1) {
    if (uint32(data, offset) !== 0x02014b50) throw new Error('Office document archive has an invalid directory entry')
    const flags = uint16(data, offset + 8)
    const compressed = uint32(data, offset + 20)
    const expanded = uint32(data, offset + 24)
    const nameLength = uint16(data, offset + 28)
    const extraLength = uint16(data, offset + 30)
    const commentLength = uint16(data, offset + 32)
    const name = decoder.decode(data.slice(offset + 46, offset + 46 + nameLength))
    assertSafeRelativePath(name)
    if (name.toLowerCase().includes('vbaproject.bin') || name.toLowerCase().endsWith('.xlsm')) hasMacros = true
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || expanded === 0xffffffff) throw new Error('encrypted or ZIP64 Office archives are not supported')
    expandedBytes += expanded
    if (expanded > limits.maxExpandedBytes || expandedBytes > limits.maxExpandedBytes || (compressed > 0 && expanded / compressed > limits.maxCompressionRatio)) throw new Error('Office document archive exceeds decompression limits')
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (hasMacros) throw new Error('Office macros are not allowed in document attachments')
  return { entries, expandedBytes, hasMacros }
}

function validateBytes(data: Uint8Array, metadata: { kind: DocumentKind }, limits: DocumentLimits): void {
  if (data.byteLength === 0) throw new Error('document is empty')
  if (data.byteLength > limits.maxBytes) throw new Error('document exceeds the configured byte limit')
  if (metadata.kind === 'docx' || metadata.kind === 'xlsx' || metadata.kind === 'pptx') inspectOfficeArchive(data, limits)
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function persist(root: string, data: Uint8Array, manifest: DocumentAttachmentManifest): Promise<void> {
  const objects = join(root, 'objects', manifest.sha256.slice(0, 2))
  const temporaryRoot = join(root, 'tmp')
  const manifests = join(root, 'manifests')
  await mkdir(objects, { recursive: true, mode: 0o700 })
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  await mkdir(manifests, { recursive: true, mode: 0o700 })
  const temporary = join(temporaryRoot, `${manifest.sha256}.${process.pid}.tmp`)
  const target = join(objects, manifest.sha256)
  await writeFile(temporary, data, { mode: 0o600 })
  try {
    try { await rename(temporary, target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await writeFile(join(manifests, `${manifest.sha256}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  } finally {
    await rm(temporary, { force: true })
  }
}

export class LocalDocumentProvider implements DocumentProvider {
  readonly name = 'local-document'
  readonly limits: DocumentLimits
  readonly root: string

  constructor(dshHome: string, limits: Partial<DocumentLimits> = {}) {
    this.limits = { ...DEFAULT_DOCUMENT_LIMITS, ...limits }
    this.root = resolve(join(dshHome, 'documents', 'v1'))
  }

  async addFile(path: string): Promise<DocumentAttachmentManifest> {
    const safePath = await realpath(path)
    const info = await lstat(safePath)
    if (!info.isFile()) throw new Error('document attachment must be a regular file')
    if (info.size > this.limits.maxBytes) throw new Error('document exceeds the configured byte limit')
    const metadata = metadataFor(safePath)
    const data = new Uint8Array(await readFile(safePath))
    validateBytes(data, metadata, this.limits)
    return this.addBytes(data, metadata.name, metadata.kind, metadata.mediaType)
  }

  async addBytes(data: Uint8Array, name: string, kind?: DocumentKind, mediaType?: string): Promise<DocumentAttachmentManifest> {
    const metadata = kind === undefined ? metadataFor(name) : { name: safeName(name), kind, mediaType: mediaType ?? EXTENSIONS[extname(name).toLowerCase()]?.mediaType ?? 'application/octet-stream' }
    validateBytes(data, metadata, this.limits)
    const sha256 = digest(data)
    const manifest: DocumentAttachmentManifest = {
      attachmentId: `sha256:${sha256}`, provider: this.name, name: metadata.name, kind: metadata.kind, mediaType: metadata.mediaType,
      bytes: data.byteLength, sha256, createdAt: new Date().toISOString(), macros: false,
      parser: `dshpilot-builtin-${metadata.kind}`, parserVersion: 1, limits: { maxBytes: this.limits.maxBytes, maxArchiveEntries: this.limits.maxArchiveEntries, maxExpandedBytes: this.limits.maxExpandedBytes, maxCompressionRatio: this.limits.maxCompressionRatio }, extractionStatus: 'pending',
    }
    await persist(this.root, data, manifest)
    return manifest
  }

  async read(attachmentId: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    if (!ID_PATTERN.test(attachmentId)) throw new Error('attachment id is invalid')
    const sha256 = attachmentId.slice('sha256:'.length)
    const data = new Uint8Array(await readFile(join(this.root, 'objects', sha256.slice(0, 2), sha256)))
    signal?.throwIfAborted()
    if (digest(data) !== sha256) throw new Error('attachment integrity check failed')
    return data
  }
}

export class DocumentProviderRegistry {
  private readonly providers = new Map<string, DocumentProvider>()

  register(provider: DocumentProvider): () => void {
    if (this.providers.has(provider.name)) throw new Error(`document provider already registered: ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => { this.providers.delete(provider.name) }
  }

  get(name: string): DocumentProvider | undefined { return this.providers.get(name) }
  list(): string[] { return [...this.providers.keys()].sort() }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !relativePath.startsWith('/'))
}
