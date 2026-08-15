import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ControlPlaneServer } from './index.js'
import type { PermissionSummary, RuntimeStatus, SessionSummary, TaskSummary } from '@dshpilot/control-contracts'
import { ArtifactStore, GitPresentation } from '@dshpilot/desktop-host'

function argument(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1] ?? fallback }
function flag(name: string): boolean { return process.argv.includes(name) }
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error } }

const dataRoot = resolve(argument('--data', process.env.DSHPILOT_APP_DATA ?? './app-data'))
const host = argument('--host', '127.0.0.1')
const port = Number(argument('--port', '6767'))
const remoteEnabled = flag('--remote')
const corsOrigins = (process.env.DSHPILOT_CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
const state = (name: string): string => resolve(dataRoot, 'desktop', name)

async function main(): Promise<void> {
  await mkdir(resolve(dataRoot, 'desktop'), { recursive: true })
  const tlsKey = process.env.DSHPILOT_TLS_KEY
  const tlsCert = process.env.DSHPILOT_TLS_CERT
  const server = new ControlPlaneServer({
    name: 'DSHPilot self-hosted daemon', version: process.env.DSHPILOT_VERSION ?? '0.1.0', host, port, remoteEnabled,
    tls: tlsKey !== undefined && tlsCert !== undefined ? { key: await readFile(resolve(tlsKey)), cert: await readFile(resolve(tlsCert)) } : undefined, corsOrigins,
    eventsPath: state('control-events.jsonl'), devicesPath: state('devices.json'),
    adapter: {
      artifacts: () => new ArtifactStore(resolve(dataRoot, 'dsh-home')).list().then(items => items),
      artifactRead: artifactId => new ArtifactStore(resolve(dataRoot, 'dsh-home')).read(artifactId),
      git: async (cwd, path) => { const git = new GitPresentation(process.env.DSHPILOT_WORKSPACE_ROOT ?? resolve(dataRoot, 'dsh-home')); return { status: await git.status(cwd), diff: await git.diff(cwd, path) } },
      resources: () => readJson(state('resources.json'), [] as unknown[]),
      lineage: async sessionId => (await readJson(state('session-lineage.json'), [] as Array<{ sessionId: string }>)).filter(item => item.sessionId === sessionId),
      runtimeStatus: () => { const snapshot = readJsonSync<Partial<RuntimeStatus>>(state('runtime-status.json')); return { ...snapshot, state: snapshot.state ?? 'idle', restartCount: snapshot.restartCount ?? 0 } },
      sessions: () => readJson(state('sessions.json'), [] as SessionSummary[]),
      tasks: () => readJson(state('tasks.json'), [] as TaskSummary[]),
      permissions: sessionId => readJson(state('permissions.json'), [] as PermissionSummary[]).then(items => sessionId === undefined ? items : items.filter(item => item.sessionId === sessionId)),
      admitPrompt: async request => { const taskId = `remote-${request.requestId}`; await appendFile(state('remote-commands.jsonl'), `${JSON.stringify({ type: 'prompt_admission', taskId, request, at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 }); return { taskId } },
      permissionReply: async (permissionId, decision) => { await appendFile(state('remote-commands.jsonl'), `${JSON.stringify({ type: 'permission_reply', permissionId, decision, at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 }) },
    },
  })
  const address = await server.start()
  process.stdout.write(`${JSON.stringify({ ready: true, ...address, protocol: tlsKey === undefined ? 'http' : 'https', remoteEnabled, dataRoot })}\n`)
  const stop = (): void => { void server.stop().finally(() => process.exit(0)) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}

function readJsonSync<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return {} as T }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
