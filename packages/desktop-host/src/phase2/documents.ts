import { crc32, inflateRawSync, inflateSync } from 'node:zlib'
import { posix } from 'node:path'
import { DEFAULT_DOCUMENT_LIMITS, type DocumentAttachmentManifest, type DocumentKind, type DocumentLimits, type DocumentProvider } from './attachments.js'

export interface DocumentInspection {
  attachmentId: string
  name: string
  kind: DocumentKind
  bytes: number
  textCharacters: number
  pages?: number
  sheets?: Array<{ name: string; index: number; rows: number; columns: number }>
  slides?: number
  manifestOnly: true
}

export interface DocumentReadResult {
  attachmentId: string
  kind: DocumentKind
  text?: string
  rows?: string[][]
  slide?: { index: number; text: string }
  truncated: boolean
  manifestOnly: false
}

export interface DocumentSearchResult {
  attachmentId: string
  query: string
  matches: Array<{ line: number; text: string }>
  truncated: boolean
}

export interface SpreadsheetSheetInfo { name: string; index: number; rows: number; columns: number }

export interface DocumentToolProvider {
  inspect(manifest: DocumentAttachmentManifest, signal?: AbortSignal): Promise<DocumentInspection>
  read(manifest: DocumentAttachmentManifest, options?: { offset?: number; limit?: number; sheet?: string | number; range?: string; slide?: number; signal?: AbortSignal }): Promise<DocumentReadResult>
  search(manifest: DocumentAttachmentManifest, query: string, options?: { maxMatches?: number; signal?: AbortSignal }): Promise<DocumentSearchResult>
  spreadsheetSheetInfo(manifest: DocumentAttachmentManifest, signal?: AbortSignal): Promise<SpreadsheetSheetInfo[]>
  spreadsheetReadRange(manifest: DocumentAttachmentManifest, sheet: string | number, range: string, signal?: AbortSignal): Promise<DocumentReadResult>
  presentationSlide(manifest: DocumentAttachmentManifest, slide: number, signal?: AbortSignal): Promise<DocumentReadResult>
}

interface ZipEntry { name: string; method: number; flags: number; checksum: number; compressedSize: number; uncompressedSize: number; localOffset: number }

function u16(data: Uint8Array, offset: number): number { return data[offset]! | (data[offset + 1]! << 8) }
function u32(data: Uint8Array, offset: number): number { return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0 }
function text(data: Uint8Array): string { return new TextDecoder('utf-8', { fatal: false }).decode(data) }
function xmlUnescape(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#x[0-9a-f]+;|&#[0-9]+;/giu, token => {
    if (token === '&amp;') return '&'; if (token === '&lt;') return '<'; if (token === '&gt;') return '>'; if (token === '&quot;') return '"'; if (token === '&apos;') return "'"
    const number = token.startsWith('&#x') || token.startsWith('&#X') ? Number.parseInt(token.slice(3, -1), 16) : Number.parseInt(token.slice(2, -1), 10)
    return Number.isSafeInteger(number) ? String.fromCodePoint(number) : token
  })
}
function xmlText(value: string): string {
  return xmlUnescape(value.replace(/<!--[\s\S]*?-->/gu, '').replace(/<[^>]*>/gu, ' ').replace(/[ \t\r\f]+/gu, ' ').replace(/\n{3,}/gu, '\n').trim())
}
function check(signal?: AbortSignal): void { signal?.throwIfAborted() }
function limited(value: string, limit: number): { value: string; truncated: boolean } { return value.length > limit ? { value: value.slice(0, limit), truncated: true } : { value, truncated: false } }

function zipEntries(data: Uint8Array, maxEntries: number, maxExpandedBytes: number, maxCompressionRatio: number, signal?: AbortSignal): Map<string, ZipEntry> {
  const start = Math.max(0, data.byteLength - 65_557); let eocd = -1
  for (let offset = data.byteLength - 22; offset >= start; offset -= 1) if (u32(data, offset) === 0x06054b50) { eocd = offset; break }
  if (eocd < 0) throw new Error('Office archive directory is missing')
  const count = u16(data, eocd + 10); const directorySize = u32(data, eocd + 12); const directoryOffset = u32(data, eocd + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || count > maxEntries || directoryOffset + directorySize > data.byteLength) throw new Error('Office archive exceeds safety limits (ZIP64 is not supported)')
  const result = new Map<string, ZipEntry>(); let offset = directoryOffset; let expandedTotal = 0
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    check(signal)
    if (offset < 0 || offset + 46 > data.byteLength || u32(data, offset) !== 0x02014b50) throw new Error('Office archive has an invalid directory entry')
    const flags = u16(data, offset + 8); const method = u16(data, offset + 10); const checksum = u32(data, offset + 16); const compressedSize = u32(data, offset + 20); const uncompressedSize = u32(data, offset + 24)
    const nameLength = u16(data, offset + 28); const extraLength = u16(data, offset + 30); const commentLength = u16(data, offset + 32); const localOffset = u32(data, offset + 42)
    const name = decoder.decode(data.slice(offset + 46, offset + 46 + nameLength)).replaceAll('\\', '/')
    if (name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) throw new Error('Office archive path traversal is not allowed')
    if ((flags & 0x1) !== 0 || uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) throw new Error('encrypted or ZIP64 Office archives are not supported')
    expandedTotal += uncompressedSize; if (uncompressedSize > maxExpandedBytes || expandedTotal > maxExpandedBytes || (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio)) throw new Error('Office archive exceeds decompression limits')
    if (method !== 0 && method !== 8) throw new Error(`unsupported Office compression method: ${method}`)
    result.set(name, { name, method, flags, checksum, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return result
}

function zipRead(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const offset = entry.localOffset
  if (u32(data, offset) !== 0x04034b50) throw new Error('Office archive local entry is invalid')
  const nameLength = u16(data, offset + 26); const extraLength = u16(data, offset + 28); const start = offset + 30 + nameLength + extraLength; const end = start + entry.compressedSize
  if (end > data.byteLength) throw new Error('Office archive entry is truncated')
  const compressed = data.slice(start, end); const value = entry.method === 0 ? compressed : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize }))
  if (value.byteLength !== entry.uncompressedSize) throw new Error('Office archive entry size mismatch')
  if (crc32(value) !== entry.checksum) throw new Error('Office archive entry checksum mismatch')
  return value
}

function officeText(data: Uint8Array, kind: 'docx' | 'pptx', signal?: AbortSignal, limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS): string {
  const entries = zipEntries(data, limits.maxArchiveEntries, limits.maxExpandedBytes, limits.maxCompressionRatio, signal); check(signal)
  const names = kind === 'docx' ? [...entries.keys()].filter(name => name === 'word/document.xml' || /^word\/header\d+\.xml$/u.test(name) || /^word\/footer\d+\.xml$/u.test(name)) : [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort((a, b) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]))
  return names.map(name => { check(signal); return xmlText(text(zipRead(data, entries.get(name)!))) }).filter(Boolean).join('\n\n')
}

function csvRows(value: string, maxRows = 20_000, signal?: AbortSignal): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    if ((index & 0x3fff) === 0) check(signal)
    const char = value[index]!
    if (quoted) { if (char === '"' && value[index + 1] === '"') { cell += '"'; index += 1 } else if (char === '"') quoted = false; else cell += char }
    else if (char === '"' && cell === '') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') { if (char === '\r' && value[index + 1] === '\n') index += 1; row.push(cell); cell = ''; if (row.some(Boolean) || rows.length > 0) rows.push(row); row = []; if (rows.length >= maxRows) break }
    else cell += char
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

function columnNumber(value: string): number { let result = 0; for (const char of value.toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64; return result - 1 }
function cellCoordinates(value: string): { row: number; column: number } { const match = value.match(/^\$?([A-Z]+)\$?(\d+)$/iu); if (!match) throw new Error(`invalid spreadsheet cell: ${value}`); return { row: Number(match[2]) - 1, column: columnNumber(match[1]!) } }
function parseRange(value: string): { from: { row: number; column: number }; to: { row: number; column: number } } { const [left, right = left] = value.split(':'); const from = cellCoordinates(left!); const to = cellCoordinates(right!); if (to.row < from.row || to.column < from.column || to.row - from.row > 2_000 || to.column - from.column > 200) throw new Error('spreadsheet range exceeds safety limits'); return { from, to } }

function spreadsheet(data: Uint8Array, signal?: AbortSignal, limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS): { sheets: SpreadsheetSheetInfo[]; rows: Map<string, string[][]> } {
  const entries = zipEntries(data, limits.maxArchiveEntries, limits.maxExpandedBytes, limits.maxCompressionRatio, signal); const shared: string[] = []; const sharedXml = entries.get('xl/sharedStrings.xml');
  if (sharedXml) for (const match of text(zipRead(data, sharedXml)).matchAll(/<si[\s\S]*?<\/si>/gu)) shared.push(xmlText(match[0]))
  const workbook = entries.get('xl/workbook.xml'); if (!workbook) throw new Error('XLSX workbook is missing')
  const names = [...text(zipRead(data, workbook)).matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/gu)].map(match => ({ name: xmlUnescape(match[1]!), rid: match[2]! }))
  const relationships = entries.get('xl/_rels/workbook.xml.rels'); const relMap = new Map<string, string>()
  if (relationships) for (const match of text(zipRead(data, relationships)).matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/gu)) {
    const target = match[2]!; if (target.startsWith('/') || target.includes('://')) throw new Error('external XLSX relationships are not allowed')
    const resolved = posix.normalize(posix.join('xl', target)); if (!resolved.startsWith('xl/') || resolved.split('/').includes('..')) throw new Error('XLSX relationship escapes the archive')
    relMap.set(match[1]!, resolved)
  }
  const rows = new Map<string, string[][]>(); const infos: SpreadsheetSheetInfo[] = []
  for (const [index, sheet] of names.entries()) { check(signal); const path = relMap.get(sheet.rid) ?? `xl/worksheets/sheet${index + 1}.xml`; const entry = entries.get(path); if (!entry) continue; const table: string[][] = []
    for (const rowMatch of text(zipRead(data, entry)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) { const cells: string[] = []; for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) { const attrs = cellMatch[1]!; const ref = attrs.match(/\br="([^"]+)"/u)?.[1]; const coordinate = ref ? cellCoordinates(ref) : { row: table.length, column: cells.length }; while (cells.length < coordinate.column) cells.push(''); const type = attrs.match(/\bt="([^"]+)"/u)?.[1]; const raw = cellMatch[2]!.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? cellMatch[2]!.match(/<t[^>]*>([\s\S]*?)<\/t>/u)?.[1] ?? ''; cells.push(xmlUnescape(type === 's' ? (shared[Number(raw)] ?? '') : raw)) } table.push(cells) }
    rows.set(sheet.name, table); infos.push({ name: sheet.name, index, rows: table.length, columns: Math.max(0, ...table.map(row => row.length)) })
  }
  return { sheets: infos, rows }
}

function pdfStrings(value: string, signal?: AbortSignal): string {
  let result = ''
  for (const match of value.matchAll(/\(([^()]*)\)/gu)) { check(signal); result += `${match[1]!.replaceAll('\\n', '\n').replaceAll('\\r', '\r').replaceAll('\\(', '(').replaceAll('\\)', ')')} ` }
  return result
}
function pdfText(data: Uint8Array, signal?: AbortSignal, maxExpandedBytes = DEFAULT_DOCUMENT_LIMITS.maxExpandedBytes): { text: string; pages: number } {
  const value = new TextDecoder('latin1').decode(data); if (/\/Encrypt\b/u.test(value)) throw new Error('encrypted PDF attachments are not supported')
  let result = pdfStrings(value, signal)
  let expandedBytes = 0
  for (const match of value.matchAll(/<<(?:[\s\S]*?)\/Filter\s*\/FlateDecode[\s\S]*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
    check(signal)
    try {
      const inflated = inflateSync(Buffer.from(match[1]!, 'latin1'), { maxOutputLength: Math.max(0, maxExpandedBytes - expandedBytes) })
      expandedBytes += inflated.byteLength
      result += ` ${pdfStrings(new TextDecoder('latin1').decode(inflated), signal)}`
    } catch (error) {
      if (String(error).toLowerCase().includes('maxoutputlength')) throw new Error('PDF decompression exceeds safety limits')
      /* malformed streams are ignored; the outer document remains inspectable */
    }
  }
  return { text: result.replace(/\s+/gu, ' ').trim(), pages: (value.match(/\/Type\s*\/Page(?!s)\b/gu) ?? []).length }
}

function plainText(data: Uint8Array, kind: DocumentKind): string { const value = text(data); if (kind === 'json') { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } } return kind === 'xml' ? xmlText(value) : value }

export class LocalDocumentTools implements DocumentToolProvider {
  constructor(readonly provider: DocumentProvider, readonly maxOutputCharacters = 200_000) {}
  private async bytes(manifest: DocumentAttachmentManifest, signal?: AbortSignal): Promise<Uint8Array> { check(signal); const data = await this.provider.read(manifest.attachmentId, signal); check(signal); return data }
  private parse(manifest: DocumentAttachmentManifest, data: Uint8Array, signal?: AbortSignal): { text: string; pages?: number; rows?: string[][]; sheets?: SpreadsheetSheetInfo[]; slides?: number } {
    const limits = manifest.limits ?? DEFAULT_DOCUMENT_LIMITS
    if (manifest.kind === 'pdf') return pdfText(data, signal, limits.maxExpandedBytes)
    if (manifest.kind === 'docx' || manifest.kind === 'pptx') { const value = officeText(data, manifest.kind, signal, limits); return { text: value, slides: manifest.kind === 'pptx' ? [...zipEntries(data, limits.maxArchiveEntries, limits.maxExpandedBytes, limits.maxCompressionRatio, signal).keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length : undefined } }
    if (manifest.kind === 'xlsx') { const value = spreadsheet(data, signal, limits); return { text: value.rows.size === 0 ? '' : [...value.rows.entries()].map(([name, rows]) => `## ${name}\n${rows.map(row => row.join('\t')).join('\n')}`).join('\n\n'), rows: value.rows.get(value.sheets[0]?.name ?? '') ?? [], sheets: value.sheets } }
    if (manifest.kind === 'csv') { const rows = csvRows(text(data), 20_000, signal); return { text: rows.map(row => row.join('\t')).join('\n'), rows } }
    return { text: plainText(data, manifest.kind) }
  }
  async inspect(manifest: DocumentAttachmentManifest, signal?: AbortSignal): Promise<DocumentInspection> { const value = this.parse(manifest, await this.bytes(manifest, signal), signal); return { attachmentId: manifest.attachmentId, name: manifest.name, kind: manifest.kind, bytes: manifest.bytes, textCharacters: value.text?.length ?? 0, ...(value.pages === undefined ? {} : { pages: value.pages }), ...(value.sheets === undefined ? {} : { sheets: value.sheets }), ...(value.slides === undefined ? {} : { slides: value.slides }), manifestOnly: true } }
  async read(manifest: DocumentAttachmentManifest, options: { offset?: number; limit?: number; sheet?: string; range?: string; slide?: number; signal?: AbortSignal } = {}): Promise<DocumentReadResult> {
    const data = await this.bytes(manifest, options.signal)
    if (manifest.kind === 'xlsx' && (options.sheet !== undefined || options.range !== undefined)) return this.spreadsheetReadRange(manifest, options.sheet ?? 0, options.range ?? 'A1:Z100', options.signal)
    if (manifest.kind === 'pptx' && options.slide !== undefined) return this.presentationSlide(manifest, options.slide, options.signal)
    const parsed = this.parse(manifest, data, options.signal); const limit = Math.min(Math.max(1, options.limit ?? this.maxOutputCharacters), this.maxOutputCharacters); const offset = Math.max(0, options.offset ?? 0); const selected = limited(parsed.text.slice(offset), limit)
    return { attachmentId: manifest.attachmentId, kind: manifest.kind, ...(parsed.rows === undefined ? { text: selected.value } : { text: selected.value, rows: parsed.rows.slice(0, 2_000) }), truncated: selected.truncated, manifestOnly: false }
  }
  async search(manifest: DocumentAttachmentManifest, query: string, options: { maxMatches?: number; signal?: AbortSignal } = {}): Promise<DocumentSearchResult> { if (query.trim() === '') throw new Error('document search query is required'); const result = await this.read(manifest, { limit: this.maxOutputCharacters, signal: options.signal }); const needle = query.toLocaleLowerCase(); const matches: Array<{ line: number; text: string }> = []; for (const [index, line] of (result.text ?? '').split(/\r?\n/u).entries()) { check(options.signal); if (line.toLocaleLowerCase().includes(needle)) { matches.push({ line: index + 1, text: line.slice(0, 4_000) }); if (matches.length >= Math.min(options.maxMatches ?? 100, 1_000)) break } } return { attachmentId: manifest.attachmentId, query, matches, truncated: result.truncated || matches.length >= Math.min(options.maxMatches ?? 100, 1_000) } }
  async spreadsheetSheetInfo(manifest: DocumentAttachmentManifest, signal?: AbortSignal): Promise<SpreadsheetSheetInfo[]> { if (manifest.kind !== 'xlsx') throw new Error('spreadsheet_sheet_info requires an XLSX attachment'); return this.parse(manifest, await this.bytes(manifest, signal), signal).sheets ?? [] }
  async spreadsheetReadRange(manifest: DocumentAttachmentManifest, sheet: string | number, range: string, signal?: AbortSignal): Promise<DocumentReadResult> { if (manifest.kind !== 'xlsx' && manifest.kind !== 'csv') throw new Error('spreadsheet_read_range requires XLSX or CSV'); const data = await this.bytes(manifest, signal); const parsed = manifest.kind === 'xlsx' ? spreadsheet(data, signal, manifest.limits ?? DEFAULT_DOCUMENT_LIMITS) : { rows: new Map([['CSV', csvRows(text(data), 20_000, signal)]]), sheets: [{ name: 'CSV', index: 0, rows: 0, columns: 0 }] }; const name = typeof sheet === 'number' ? parsed.sheets[sheet]?.name : sheet; if (!name || !parsed.rows.has(name)) throw new Error(`unknown spreadsheet sheet: ${String(sheet)}`); const table = parsed.rows.get(name)!; const bounds = parseRange(range); const rows = table.slice(bounds.from.row, bounds.to.row + 1).map(row => row.slice(bounds.from.column, bounds.to.column + 1)); return { attachmentId: manifest.attachmentId, kind: manifest.kind, rows, text: rows.map(row => row.join('\t')).join('\n'), truncated: false, manifestOnly: false } }
  async presentationSlide(manifest: DocumentAttachmentManifest, slide: number, signal?: AbortSignal): Promise<DocumentReadResult> { if (manifest.kind !== 'pptx') throw new Error('presentation_slide requires a PPTX attachment'); if (!Number.isInteger(slide) || slide < 0) throw new Error('slide index must be a non-negative integer'); const data = await this.bytes(manifest, signal); const limits = manifest.limits ?? DEFAULT_DOCUMENT_LIMITS; const entries = zipEntries(data, limits.maxArchiveEntries, limits.maxExpandedBytes, limits.maxCompressionRatio, signal); const path = `ppt/slides/slide${slide + 1}.xml`; const entry = entries.get(path); if (!entry) throw new Error(`slide does not exist: ${slide}`); const value = limited(xmlText(text(zipRead(data, entry))), this.maxOutputCharacters); return { attachmentId: manifest.attachmentId, kind: manifest.kind, slide: { index: slide, text: value.value }, text: value.value, truncated: value.truncated, manifestOnly: false } }
}
