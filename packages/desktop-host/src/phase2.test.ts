import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LocalDocumentProvider, McpManager, assertSafeRelativePath, createDesktopNotification, estimateTokens, inspectTokenUsage,
  parseMcpImport, renderMcpPatch, shouldNotify,
} from './index.js'

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

  it('allows only the four Phase 2 notification kinds', () => {
    const notification = createDesktopNotification('approval-needed', 'Approval required', 'Review the pending action.')
    expect(shouldNotify(notification)).toBe(true)
    expect(shouldNotify(notification, { enabled: false, kinds: {
      'task-completed': true, 'task-failed': true, 'approval-needed': true, 'question-needed': true,
    } })).toBe(false)
  })
})
