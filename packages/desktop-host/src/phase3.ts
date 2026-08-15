import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { ControlEvent, SessionSummary, TaskSummary } from '@dshpilot/control-contracts'
import { isPathInside } from './phase2/attachments.js'

const execFileAsync = promisify(execFile)
const ARTIFACT_ID = /^sha256:[a-f0-9]{64}$/u

export interface ArtifactManifest { artifactId: string; name: string; mediaType: string; bytes: number; sha256: string; createdAt: string; readonly: true }
export interface ResourceReference { resourceId: string; kind: 'file' | 'folder' | 'git' | 'github-repository' | 'github-pr' | 'github-issue' | 'url'; label: string; locator: string; createdAt: string }
export type ResourceOperation = 'inspect' | 'tree' | 'search' | 'read' | 'diff' | 'history'
export interface SessionLineage { sessionId: string; parentSessionId?: string; rootSessionId: string; createdAt: string }

function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
function safeArtifact(id: string): string { if (!ARTIFACT_ID.test(id)) throw new Error('artifact id is invalid'); return id.slice('sha256:'.length) }
function safeLeaf(value: string): string { const leaf = basename(value).replace(/[\u0000-\u001f\u007f]/gu, '').trim(); if (!leaf || leaf === '.' || leaf === '..') throw new Error('artifact name is invalid'); return leaf.slice(0, 255) }

export class ArtifactStore {
  readonly root: string
  constructor(dshHome: string) { this.root = resolve(join(dshHome, 'artifacts', 'v1')) }
  async put(data: Uint8Array, name: string, mediaType = 'application/octet-stream'): Promise<ArtifactManifest> {
    if (data.byteLength > 100 * 1024 * 1024) throw new Error('artifact exceeds 100 MiB')
    const sha256 = digest(data); const artifactId = `sha256:${sha256}`; const directory = join(this.root, 'objects', sha256.slice(0, 2)); const target = join(directory, sha256)
    await mkdir(directory, { recursive: true, mode: 0o700 }); try { await stat(target) } catch { await writeFile(target, data, { mode: 0o600 }) }
    const manifest: ArtifactManifest = { artifactId, name: safeLeaf(name), mediaType, bytes: data.byteLength, sha256, createdAt: new Date().toISOString(), readonly: true }
    await mkdir(join(this.root, 'manifests'), { recursive: true, mode: 0o700 }); const temporary = join(this.root, 'manifests', `${sha256}.tmp`); const manifestPath = join(this.root, 'manifests', `${sha256}.json`); await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); try { await rename(temporary, manifestPath) } catch (error) { if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await rm(manifestPath, { force: true }); await rename(temporary, manifestPath) }
    return manifest
  }
  async list(): Promise<ArtifactManifest[]> {
    try { const names = await readdir(join(this.root, 'manifests')); const result: ArtifactManifest[] = []; for (const name of names.filter(item => item.endsWith('.json'))) result.push(JSON.parse(await readFile(join(this.root, 'manifests', name), 'utf8')) as ArtifactManifest); return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async read(artifactId: string, maxBytes = 100 * 1024 * 1024): Promise<Uint8Array> { const sha256 = safeArtifact(artifactId); const path = join(this.root, 'objects', sha256.slice(0, 2), sha256); const info = await stat(path); if (info.size > maxBytes) throw new Error('artifact exceeds read limit'); const data = new Uint8Array(await readFile(path)); if (data.byteLength > maxBytes || digest(data) !== sha256) throw new Error('artifact integrity or size check failed'); return data }
  async saveAs(artifactId: string, destination: string): Promise<string> { const target = resolve(destination); await mkdir(dirname(target), { recursive: true }); await writeFile(target, await this.read(artifactId)); return target }
  reveal(artifactId: string): string { const sha256 = safeArtifact(artifactId); return join(this.root, 'objects', sha256.slice(0, 2), sha256) }
  async open(artifactId: string): Promise<{ opened: boolean }> {
    const target = this.reveal(artifactId)
    await stat(target)
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
    try { await execFileAsync(command, [target], { timeout: 15_000 }); return { opened: true } } catch { return { opened: false } }
  }
  async revealInFileManager(artifactId: string): Promise<{ opened: boolean }> {
    const target = this.reveal(artifactId)
    await stat(target)
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
    const args = process.platform === 'darwin' ? ['-R', target] : process.platform === 'win32' ? [`/select,${target}`] : [dirname(target)]
    try { await execFileAsync(command, args, { timeout: 15_000 }); return { opened: true } } catch { return { opened: false } }
  }
}

async function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const result = await execFileAsync('git', ['--no-pager', ...args], { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 })
  return result.stdout
}

export class GitPresentation {
  constructor(readonly workspaceRoot: string) {}
  private async cwd(value: string): Promise<string> { const root = await realpath(this.workspaceRoot); const resolved = await realpath(resolve(value)); if (!isPathInside(root, resolved)) throw new Error('git workspace is outside the trusted root'); return resolved }
  async status(cwd: string): Promise<string> { return git(await this.cwd(cwd), ['status', '--short']) }
  async diff(cwd: string, path?: string): Promise<string> { const worktree = await this.cwd(cwd); const args = ['diff', '--no-ext-diff']; if (path !== undefined) { const safe = resolve(worktree, path); if (!isPathInside(worktree, safe)) throw new Error('git diff path is outside the workspace'); const parent = await realpath(dirname(safe)); if (!isPathInside(worktree, parent)) throw new Error('git diff path escapes the workspace'); try { if (!isPathInside(worktree, await realpath(safe))) throw new Error('git diff path symlink escapes the workspace') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } args.push('--', relative(worktree, safe)) } return git(worktree, args) }
  async summary(cwd: string, path?: string): Promise<{ branch: string; status: string; staged: string[]; unstaged: string[]; changedFiles: string[]; diff: string; commit: string }> {
    const worktree = await this.cwd(cwd); const status = await git(worktree, ['status', '--short']); const lines = status.split('\n').filter(Boolean)
    return {
      branch: (await git(worktree, ['branch', '--show-current'])).trim(), status,
      staged: lines.filter(line => line[0] !== ' ' && line[0] !== '?').map(line => line.slice(3)),
      unstaged: lines.filter(line => line[1] !== ' ' && line[1] !== '?').map(line => line.slice(3)),
      changedFiles: lines.map(line => line.slice(3)), diff: await this.diff(worktree, path), commit: (await git(worktree, ['log', '-1', '--format=%h %s'])).trim(),
    }
  }
}

export class ResourceProviderRegistry {
  private readonly providers = new Map<string, (resource: ResourceReference, operation: ResourceOperation, input?: Record<string, unknown>) => Promise<unknown>>()
  register(kind: ResourceReference['kind'], provider: (resource: ResourceReference, operation?: ResourceOperation, input?: Record<string, unknown>) => Promise<unknown>): () => void {
    if (this.providers.has(kind)) throw new Error(`resource provider already registered: ${kind}`)
    this.providers.set(kind, (resource, operation, input) => provider(resource, operation, input))
    return () => this.providers.delete(kind)
  }
  list(): string[] { return [...this.providers.keys()].sort() }
  resolve(resource: ResourceReference, operation: ResourceOperation = 'inspect', input?: Record<string, unknown>): Promise<unknown> { const provider = this.providers.get(resource.kind); if (provider === undefined) throw new Error(`resource provider is unavailable: ${resource.kind}`); return provider(resource, operation, input) }
}

export class SessionLineageStore {
  private readonly records = new Map<string, SessionLineage>()
  add(record: SessionLineage): void { if (record.parentSessionId === record.sessionId) throw new Error('session cannot be its own parent'); this.records.set(record.sessionId, { ...record, rootSessionId: record.rootSessionId || record.sessionId }) }
  lineage(sessionId: string): SessionLineage[] { const result: SessionLineage[] = []; let current = this.records.get(sessionId); const seen = new Set<string>(); while (current !== undefined && !seen.has(current.sessionId)) { result.unshift(current); seen.add(current.sessionId); current = current.parentSessionId === undefined ? undefined : this.records.get(current.parentSessionId) } return result }
  list(): SessionLineage[] { return [...this.records.values()] }
}

export class TaskProjection {
  private readonly tasks = new Map<string, TaskSummary>()
  apply(event: ControlEvent): void { if (event.type !== 'task.updated') return; const task = event.payload as Partial<TaskSummary>; if (typeof task.taskId !== 'string' || typeof task.status !== 'string' || typeof task.updatedAt !== 'string') return; this.tasks.set(task.taskId, task as TaskSummary) }
  list(): TaskSummary[] { return [...this.tasks.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) }
}

export function projectSessions(events: readonly ControlEvent[]): { sessions: SessionSummary[]; tasks: TaskSummary[] } { const tasks = new TaskProjection(); for (const event of events) tasks.apply(event); return { sessions: [], tasks: tasks.list() } }
