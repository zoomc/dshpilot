import { RemoteRelayServer } from './index.js'
import { readFileSync } from 'node:fs'

const keyPath = process.env.DSHPILOT_RELAY_TLS_KEY
const certPath = process.env.DSHPILOT_RELAY_TLS_CERT
if ((keyPath === undefined) !== (certPath === undefined)) throw new Error('DSHPILOT_RELAY_TLS_KEY and DSHPILOT_RELAY_TLS_CERT must be provided together')
const csv = (value: string | undefined): string[] | undefined => { const items = value?.split(',').map(item => item.trim()).filter(Boolean); return items === undefined || items.length === 0 ? undefined : items }
const server = new RemoteRelayServer({ host: process.env.DSHPILOT_RELAY_HOST ?? '127.0.0.1', port: Number(process.env.DSHPILOT_RELAY_PORT ?? '8787'), token: process.env.DSHPILOT_RELAY_TOKEN, allowedHosts: csv(process.env.DSHPILOT_RELAY_ALLOWED_HOSTS), allowedOrigins: csv(process.env.DSHPILOT_RELAY_ALLOWED_ORIGINS), ...(keyPath === undefined || certPath === undefined ? {} : { tls: { key: readFileSync(keyPath), cert: readFileSync(certPath) } }) })
const address = await server.start()
console.log(JSON.stringify({ dshpilotRelay: 'ready', ...address, protocol: 'dshpilot-relay-v1' }))
const stop = (): void => { void server.stop().finally(() => process.exit(0)) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
