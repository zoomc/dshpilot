import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalDocumentProvider, McpManager } from '@dshpilot/desktop-host'
import { apply, liveMcpRecords, projectHarnessEvent, readBoundedFile, reconcileMcpLoader, resolvePublicAddresses, restartMcpLoader } from './index.js'

interface FixtureEntry {
  id: string
  options: { name: string; config?: unknown; disabled?: boolean }
  fiber?: { state?: number }
}

function fixtureLoader(initial: FixtureEntry[] = []) {
  const entries = [...initial]
  let nextId = 0
  let updates = 0
  return {
    entries: () => entries,
    async create(options: { name: string; config?: unknown; disabled?: boolean }): Promise<string> {
      const id = `fixture-${nextId++}`
      entries.push({ id, options, fiber: { state: 2 } })
      return id
    },
    async update(id: string, options: { config?: unknown; disabled?: boolean }): Promise<void> {
      const entry = entries.find(candidate => candidate.id === id)
      if (entry === undefined) throw new Error(`unknown fixture entry ${id}`)
      entry.options = { ...entry.options, ...options }; entry.fiber = { state: 2 }; updates += 1
    },
    async remove(id: string): Promise<void> {
      const index = entries.findIndex(candidate => candidate.id === id)
      if (index >= 0) entries.splice(index, 1)
    },
    get updates(): number { return updates },
  }
}

describe('DSHPilot Host plugin document tool seam', () => {
  it('registers all document tools with the official tools registry and keeps bodies on demand', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshpilot-plugin-')); const previous = process.env.DSH_HOME; process.env.DSH_HOME = home
    try {
      const manifest = await new LocalDocumentProvider(home).addBytes(new TextEncoder().encode('alpha\nbeta\n'), 'notes.txt')
      const definitions: Array<Record<string, unknown>> = []
      apply({
        tools: { register(definition) { definitions.push(definition as Record<string, unknown>); return () => undefined } },
        webServer: { register() { return () => undefined } },
        effect(callback) { callback() },
      })
      expect(definitions.map(value => value.name)).toEqual(['document_inspect', 'document_read', 'document_search', 'spreadsheet_sheet_info', 'spreadsheet_read_range', 'presentation_slide', 'resource_inspect', 'resource_tree', 'resource_search', 'resource_read', 'resource_diff', 'resource_history'])
      const search = definitions.find(value => value.name === 'document_search')!
      const result = await (search.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>)({ attachmentId: manifest.attachmentId, query: 'beta' }, { signal: new AbortController().signal })
      expect(result).toMatchObject({ matches: [{ line: 2, text: 'beta' }] })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('reconciles a persisted MCP record through the official Loader and ToolRuntime fixture seams', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshpilot-mcp-fixture-')); const previous = process.env.DSH_HOME; process.env.DSH_HOME = home
    try {
      const manager = new McpManager(home)
      await manager.upsert({
        id: 'fixture-server', serverName: 'fixture_server', transport: 'stdio', enabled: true, status: 'configured',
        command: 'fixture-mcp', args: [], env: {}, envRefs: { MCP_TOKEN: 'DSHPILOT_MCP_TOKEN' }, headers: {}, headerRefs: {}, updatedAt: new Date().toISOString(),
      })
      const loader = fixtureLoader()
      const definitions: Array<Record<string, unknown>> = []
      const credentials = { resolve: async (ref: string) => ref === 'DSHPILOT_MCP_TOKEN' ? { value: 'fixture-secret', source: 'fixture' } : undefined }
      await apply({
        loader,
        credentials,
        tools: {
          register(definition) { definitions.push(definition as Record<string, unknown>); return () => undefined },
          schemas: () => [{ name: 'mcp__fixture_server__search' }],
        },
        webServer: { register() { return () => undefined } },
        effect(callback) { callback() },
      })
      expect(loader.entries()).toHaveLength(1)
      expect((loader.entries()[0]!.options.config as { env: Record<string, string> }).env).toEqual({ MCP_TOKEN: 'fixture-secret' })
      expect(await readFile(manager.statePath, 'utf8')).not.toContain('fixture-secret')
      expect(definitions).toHaveLength(12)

      const records = await manager.list()
      expect(liveMcpRecords({ loader, tools: { register: () => () => undefined, schemas: () => [{ name: 'mcp__fixture_server__search' }] } }, records)[0]).toMatchObject({
        status: 'ready', toolCount: 1, statusSource: 'loader-fiber', toolCountSource: 'tools-registry',
      })
      expect((await reconcileMcpLoader({ loader, credentials }, records)).reloaded).toBe(false)
      expect(loader.updates).toBe(0)
      expect(await restartMcpLoader({ loader, credentials }, records[0]!)).toEqual({ restarted: true, managedEntries: 1 })
      expect(loader.updates).toBe(2)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('projects bounded redacted assistant output for the remote Task Center', () => {
    const event = projectHarnessEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer sk-test-secret-1234567890 token=hidden-value' }] } } })
    expect(event).toMatchObject({ kind: 'assistant/message', text: expect.stringContaining('[redacted-secret]') })
    expect(event.text).not.toContain('hidden-value')
  })
})

describe('DSHPilot Host plugin filesystem and DNS seam hardening', () => {
  it('streams a file and never returns more than the requested byte cap', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshpilot-bounded-')); const target = join(home, 'big.bin')
    const payload = 'x'.repeat(64 * 1024) + 'y'.repeat(64 * 1024) // 128 KiB of data
    await writeFile(target, payload, 'utf8')
    const limit = 4096
    const result = await readBoundedFile(target, 0, limit)
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(limit)
    expect(result.content).toBe(payload.slice(0, limit))
    // An offset in the middle stays capped relative to the start of the read.
    const sliced = await readBoundedFile(target, 4096, limit)
    expect(sliced.truncated).toBe(true)
    expect(sliced.content.length).toBeLessThanOrEqual(limit)
    expect(sliced.content).toBe(payload.slice(4096, 4096 + limit))
  })

  it('rejects private/loopback hostnames so a URL resource cannot resolve to an internal address', async () => {
    await expect(resolvePublicAddresses('127.0.0.1')).rejects.toThrow(/private or loopback/i)
    await expect(resolvePublicAddresses('10.0.0.5')).rejects.toThrow(/private or loopback/i)
    await expect(resolvePublicAddresses('192.168.1.1')).rejects.toThrow(/private or loopback/i)
    await expect(resolvePublicAddresses('::1')).rejects.toThrow(/private or loopback/i)
    await expect(resolvePublicAddresses('fc00::1')).rejects.toThrow(/private or loopback/i)
  })
})
