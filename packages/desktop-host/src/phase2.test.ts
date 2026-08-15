import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IsolatedDocumentTools, LocalDocumentProvider, LocalDocumentTools, McpManager, ParserWorkerError, assertSafeRelativePath, createDesktopNotification, estimateTokens, inspectTokenUsage,
  officialMcpPluginConfig, parseMcpImport, renderMcpPatch, resolveOfficialMcpPluginConfig, shouldNotify,
} from './index.js'

function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name); const content = Buffer.from(value); const checksum = crc32(content)
    const local = Buffer.alloc(30 + filename.length + content.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30); content.copy(local, 30 + filename.length); locals.push(local)
    const directory = Buffer.alloc(46 + filename.length); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42); filename.copy(directory, 46); central.push(directory); offset += local.length
  }
  const directoryOffset = offset; const directorySize = central.reduce((sum, value) => sum + value.length, 0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(directoryOffset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...central, end]))
}

describe('MCP manager and import', () => {
  it('redacts literal secrets and generates an official plugin patch', () => {
    const preview = parseMcpImport(JSON.stringify({ mcpServers: {
      github: { command: 'github-mcp', env: { GITHUB_TOKEN: 'sk-live-secret', MODE: 'readonly' } },
    } }), 'claude.json')
    expect(preview.format).toBe('claude')
    expect(preview.warnings).toHaveLength(1)
    expect(preview.servers[0]?.env).toEqual({ MODE: 'readonly' })
    expect(preview.servers[0]?.envRefs).toEqual({})
    const patch = renderMcpPatch(preview.servers)
    expect(patch).toContain('@deepseek-ai/dsh-mcp-client')
    expect(patch).toContain('"MODE": "readonly"')
    expect(patch).not.toContain('sk-live-secret')
  })

  it('resolves credential references only in the in-memory official plugin config', async () => {
    const preview = parseMcpImport(JSON.stringify({ mcpServers: {
      secure: { command: 'fixture-mcp', env: { MCP_TOKEN: '${DSHPILOT_MCP_TOKEN}', MODE: 'readonly' } },
    } }))
    const record = preview.servers[0]!
    const config = await resolveOfficialMcpPluginConfig(record, {
      resolve: async ref => ref === 'DSHPILOT_MCP_TOKEN' ? { value: 'secret-only-in-memory', source: 'fixture' } : undefined,
    })
    expect(config.env).toEqual({ MODE: 'readonly', MCP_TOKEN: 'secret-only-in-memory' })
    expect(JSON.stringify(record)).not.toContain('secret-only-in-memory')
    expect(renderMcpPatch([record])).toContain('process.env.DSHPILOT_MCP_TOKEN')
    await expect(resolveOfficialMcpPluginConfig(record, { resolve: async () => undefined })).rejects.toThrow('credential reference')
  })

  it('requires explicit confirmation before import and persists the overlay atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-mcp-'))
    const manager = new McpManager(root)
    const preview = parseMcpImport(JSON.stringify({ servers: {
      docs: { transport: 'streamable-http', url: 'http://127.0.0.1:9123/mcp', headers: { Authorization: '${MCP_TOKEN}' } },
    } }), 'generic.json')
    expect((await manager.import(preview, false)).applied).toBe(false)
    const result = await manager.import(preview, true)
    expect(result.records[0]?.headerRefs).toEqual({ Authorization: 'MCP_TOKEN' })
    expect((await manager.updateRuntimeStatus('docs', { status: 'ready', toolCount: 3 })).find(item => item.id === 'docs')?.toolCount).toBe(3)
    expect(await readFile(manager.patchPath, 'utf8')).toContain('!!js process.env.MCP_TOKEN')
    expect(await manager.list()).toHaveLength(1)
  })
})

describe('token inspector', () => {
  it('prefers official usage and labels fallback estimates', () => {
    expect(inspectTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }, { messages: ['large'] }).source).toBe('official')
    const estimate = estimateTokens({ messages: ['a'.repeat(20)], attachmentManifests: [{ bytes: 20 }] })
    expect(estimate.estimate).toBe(true)
    expect(estimate.inputTokens).toBeGreaterThan(0)
  })
})

describe('document provider and notifications', () => {
  it('stores documents by digest and reads the body only on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-docs-'))
    const provider = new LocalDocumentProvider(root)
    const manifest = await provider.addBytes(new TextEncoder().encode('# hello'), 'notes.md')
    expect(manifest.attachmentId).toMatch(/^sha256:/u)
    expect(new TextDecoder().decode(await provider.read(manifest.attachmentId))).toBe('# hello')
    await expect(provider.addBytes(new Uint8Array(), 'empty.txt')).rejects.toThrow('empty')
    expect(() => assertSafeRelativePath('../outside.txt')).toThrow('traversal')
    expect(() => assertSafeRelativePath('C:/outside.txt')).toThrow('traversal')
  })

  it('parses the required document formats through bounded provider tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-parsers-')); const provider = new LocalDocumentProvider(root); const tools = new LocalDocumentTools(provider)
    const docx = await provider.addBytes(zip({ 'word/document.xml': '<document><body><p>Hello <b>DOCX</b></p></body></document>' }), 'brief.docx')
    expect((await tools.read(docx)).text).toContain('Hello DOCX')
    const xlsx = await provider.addBytes(zip({
      'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si></sst>',
    }), 'data.xlsx')
    expect(await tools.spreadsheetSheetInfo(xlsx)).toEqual([{ name: 'Data', index: 0, rows: 1, columns: 2 }])
    expect((await tools.spreadsheetReadRange(xlsx, 'Data', 'A1:B1')).rows).toEqual([['Name', '42']])
    const pptx = await provider.addBytes(zip({ 'ppt/slides/slide1.xml': '<p:sld><p:cSld><a:t>Slide one</a:t></p:cSld></p:sld>' }), 'deck.pptx')
    expect((await tools.presentationSlide(pptx, 0)).text).toContain('Slide one')
    const csv = await provider.addBytes(new TextEncoder().encode('name,description\n"Ada, L.",builder\n'), 'people.csv')
    expect((await tools.read(csv)).rows).toEqual([['name', 'description'], ['Ada, L.', 'builder']])
    const pdf = await provider.addBytes(new TextEncoder().encode('%PDF-1.7 /Type /Page (Hello PDF)'), 'note.pdf')
    expect((await tools.inspect(pdf)).pages).toBe(1)
    expect((await tools.search(docx, 'docx')).matches[0]?.line).toBe(1)
  })

  it('runs PDF, Office, and CSV calls in a killable subprocess with hard timeout cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-parser-timeout-root-'))
    const provider = new LocalDocumentProvider(root)
    const documents = [
      { name: 'timeout.pdf', data: new TextEncoder().encode('%PDF-1.7 /Type /Page (timeout)') },
      { name: 'timeout.docx', data: zip({ 'word/document.xml': '<document><body>timeout</body></document>' }) },
      { name: 'timeout.csv', data: new TextEncoder().encode('a,b\n1,2\n') },
    ]
    const hangingWorker = { executable: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] }
    for (const document of documents) {
      const manifest = await provider.addBytes(document.data, document.name)
      const tools = new IsolatedDocumentTools(provider, 200_000, { tempRoot: root, timeoutMs: 150, workerCommand: hangingWorker })
      await expect(tools.inspect(manifest)).rejects.toMatchObject({ code: 'timeout' })
    }
    expect(await readdir(root)).toEqual(['documents'])
  })

  it('turns a parser crash into a typed error and removes the private request directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-parser-crash-root-'))
    const provider = new LocalDocumentProvider(root)
    const manifest = await provider.addBytes(new TextEncoder().encode('a,b\n1,2\n'), 'crash.csv')
    const tools = new IsolatedDocumentTools(provider, 200_000, {
      tempRoot: root,
      workerCommand: { executable: process.execPath, args: ['-e', 'process.exit(23)'] },
    })
    const error = await tools.read(manifest).catch(value => value)
    expect(error).toBeInstanceOf(ParserWorkerError)
    expect(error).toMatchObject({ code: 'crashed' })
    expect(await readdir(root)).toEqual(['documents'])
  })

  it('uses 0700 request directories and 0600 input files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-parser-permissions-root-'))
    const probe = join(root, 'probe.json')
    const provider = new LocalDocumentProvider(root)
    const manifest = await provider.addBytes(new TextEncoder().encode('a,b\n1,2\n'), 'permissions.csv')
    const script = [
      "let input=''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {",
      "const fs = require('node:fs'); const path = require('node:path'); const request = JSON.parse(input);",
      "fs.writeFileSync(process.env.DSHPILOT_PROBE, JSON.stringify({ directory: fs.statSync(path.dirname(request.inputPath)).mode & 0o777, file: fs.statSync(request.inputPath).mode & 0o777 }));",
      "process.stdout.write(JSON.stringify({ ok: true, value: { attachmentId: request.manifest.attachmentId, name: request.manifest.name, kind: request.manifest.kind, bytes: request.manifest.bytes, textCharacters: 0, manifestOnly: true } })); });",
    ].join(' ')
    const tools = new IsolatedDocumentTools(provider, 200_000, {
      tempRoot: root,
      workerCommand: { executable: process.execPath, args: ['-e', script], env: { DSHPILOT_PROBE: probe } },
    })
    await tools.inspect(manifest)
    const modes = JSON.parse(await readFile(probe, 'utf8')) as { directory: number; file: number }
    if (process.platform !== 'win32') expect(modes).toEqual({ directory: 0o700, file: 0o600 })
    expect(await readdir(root)).toEqual(['documents', 'probe.json'])
  })

  it('renders the official MCP plugin configuration including reconnect policy', () => {
    const preview = parseMcpImport(JSON.stringify({ mcpServers: { tools: { command: 'fixture', reconnect: { maxAttempts: 3 } } } }))
    const config = officialMcpPluginConfig(preview.servers[0]!)
    expect(config.reconnect?.maxAttempts).toBe(3)
    expect(renderMcpPatch(preview.servers)).toContain('reconnect:')
  })

  it('allows only the four Phase 2 notification kinds', () => {
    const notification = createDesktopNotification('approval-needed', 'Approval required', 'Review the pending action.')
    expect(shouldNotify(notification)).toBe(true)
    expect(shouldNotify(notification, { enabled: false, kinds: {
      'task-completed': true, 'task-failed': true, 'approval-needed': true, 'question-needed': true,
    } })).toBe(false)
  })
})
