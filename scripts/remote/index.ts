import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ControlPlaneServer } from '../../packages/remote-daemon/src/index.js'

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

const dataRoot = resolve(argument('--data', process.env.DSHPILOT_APP_DATA ?? './app-data'))
const host = argument('--host', '127.0.0.1')
const port = Number(argument('--port', '0'))
const remoteEnabled = process.argv.includes('--remote')
const corsOrigins = argument('--cors', process.env.DSHPILOT_CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
const tlsKey = process.argv.includes('--tls-key') ? process.argv[process.argv.indexOf('--tls-key') + 1] : process.env.DSHPILOT_TLS_KEY
const tlsCert = process.argv.includes('--tls-cert') ? process.argv[process.argv.indexOf('--tls-cert') + 1] : process.env.DSHPILOT_TLS_CERT

async function main(): Promise<void> {
  await mkdir(dataRoot, { recursive: true })
  const tls = tlsKey !== undefined && tlsCert !== undefined ? { key: await readFile(resolve(tlsKey)), cert: await readFile(resolve(tlsCert)) } : undefined
  const server = new ControlPlaneServer({
    name: 'DSHPilot self-hosted daemon', version: process.env.npm_package_version ?? '0.1.0', host, port,
    remoteEnabled, tls, corsOrigins, relayEnabled: remoteEnabled,
    allowLocalPairingOffer: process.env.DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING === '1',
    allowLocalAdminPairing: process.env.DSHPILOT_REMOTE_ALLOW_LOCAL_ADMIN === '1',
    eventsPath: resolve(dataRoot, 'desktop', 'control-events.jsonl'),
    devicesPath: resolve(dataRoot, 'desktop', 'devices.json'),
    adapter: {
      runtimeStatus: () => ({ state: 'idle', restartCount: 0 }),
      sessions: async () => [],
      tasks: async () => [],
    },
  })
  const address = await server.start()
  process.stdout.write(`${JSON.stringify({ ready: true, ...address, protocol: tls === undefined ? 'http' : 'https', remoteEnabled, dataRoot })}\n`)
  const stop = (): void => { void server.stop().finally(() => process.exit(0)) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
