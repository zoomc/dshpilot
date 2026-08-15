import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalDocumentProvider } from '@dshpilot/desktop-host'
import { apply } from './index.js'

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
      expect(definitions.map(value => value.name)).toEqual(['document_inspect', 'document_read', 'document_search', 'spreadsheet_sheet_info', 'spreadsheet_read_range', 'presentation_slide'])
      const search = definitions.find(value => value.name === 'document_search')!
      const result = await (search.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>)({ attachmentId: manifest.attachmentId, query: 'beta' }, { signal: new AbortController().signal })
      expect(result).toMatchObject({ matches: [{ line: 2, text: 'beta' }] })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

