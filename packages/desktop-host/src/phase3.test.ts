import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ControlEvent } from '@dshpilot/control-contracts'
import { ArtifactStore, ResourceProviderRegistry, SessionLineageStore, TaskProjection, isPathInside } from './index.js'

describe('Phase 3 projections and artifacts', () => {
  it('stores immutable artifacts by digest and supports explicit Save As/Reveal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-artifacts-')); const store = new ArtifactStore(root)
    const manifest = await store.put(new TextEncoder().encode('artifact body'), 'report.txt', 'text/plain')
    expect(manifest.readonly).toBe(true); expect((await store.list())).toHaveLength(1)
    const destination = join(root, 'saved', 'report.txt'); await store.saveAs(manifest.artifactId, destination)
    await expect(readFile(destination, 'utf8')).resolves.toBe('artifact body')
    expect(store.reveal(manifest.artifactId)).toContain('/objects/')
  })

  it('projects task facts without creating a second session database', () => {
    const projection = new TaskProjection(); const event = { protocolVersion: 1, generation: 'g', seq: 1, eventId: 'e', type: 'task.updated', at: new Date().toISOString(), payload: { taskId: 'task-1', status: 'running', updatedAt: new Date().toISOString() } } as ControlEvent
    projection.apply(event); expect(projection.list()[0]?.taskId).toBe('task-1')
  })

  it('keeps session lineage as a projection and blocks self-parenting', () => {
    const root = '/tmp/dshpilot-lineage'
    const lineage = new SessionLineageStore(); lineage.add({ sessionId: 'root', rootSessionId: 'root', createdAt: new Date().toISOString() }); lineage.add({ sessionId: 'child', parentSessionId: 'root', rootSessionId: 'root', createdAt: new Date().toISOString() })
    expect(lineage.lineage('child').map(item => item.sessionId)).toEqual(['root', 'child']); expect(() => lineage.add({ sessionId: 'x', parentSessionId: 'x', rootSessionId: 'x', createdAt: new Date().toISOString() })).toThrow('own parent')
    expect(isPathInside(root, join(root, 'saved'))).toBe(true)
  })

  it('keeps resource operations behind a provider registry seam', async () => {
    const registry = new ResourceProviderRegistry()
    const dispose = registry.register('file', async (resource, operation, input) => ({ resourceId: resource.resourceId, operation, input }))
    const value = await registry.resolve({ resourceId: 'file-1', kind: 'file', label: 'File', locator: '/tmp/file', createdAt: new Date().toISOString() }, 'read', { offset: 12 })
    expect(value).toEqual({ resourceId: 'file-1', operation: 'read', input: { offset: 12 } })
    expect(registry.list()).toEqual(['file']); dispose(); expect(registry.list()).toEqual([])
  })
})
