import { access, cp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { superviseHarness } from '../../packages/remote-daemon/src/bin.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

function argument(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1] ?? fallback }
async function materializeLocalPackages(home: string): Promise<void> {
  const destination = join(home, 'profiles', 'node_modules', '@dshpilot')
  await mkdir(destination, { recursive: true })
  for (const packageName of ['control-contracts', 'desktop-host', 'dsh-plugin-desktop', 'dsh-client-desktop', 'remote-daemon', 'remote-client']) {
    const source = join(projectRoot, 'packages', packageName === 'dsh-plugin-desktop' || packageName === 'dsh-client-desktop' ? packageName : packageName)
    const target = join(destination, packageName)
    try { await access(join(source, 'lib', 'index.js')); await cp(source, target, { recursive: true }) } catch { /* packaged runtimes already contain the package graph */ }
  }
}

async function main(): Promise<void> {
  const runtimeRoot = process.env.DSHPILOT_RUNTIME_ROOT === undefined ? undefined : resolve(process.env.DSHPILOT_RUNTIME_ROOT)
  const dataRoot = resolve(argument('--data', process.env.DSHPILOT_APP_DATA ?? join(tmpdir(), 'dshpilot-remote-data')))
  const home = join(dataRoot, 'dsh-home')
  await mkdir(home, { recursive: true, mode: 0o700 }); await materializeLocalPackages(home)
  const patchPath = join(dataRoot, 'dshpilot.patch.yml')
  try { await access(patchPath) } catch {
    await writeFile(patchPath, "# DSHPilot self-hosted Harness integration\n- insert:\n    - id: dshpilot-host\n      name: '@dshpilot/dsh-plugin-desktop'\n      inject: [webServer, apiProxy, tools, loader]\n    - id: dshpilot-client\n      name: '@dshpilot/dsh-client-desktop'\n", { encoding: 'utf8', mode: 0o600 })
  }
  const node = runtimeRoot === undefined ? process.execPath : join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  const script = runtimeRoot === undefined ? join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js') : join(runtimeRoot, 'dsh', 'lib', 'bin.js')
  const args = [script, 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', argument('--port', '0')]
  await superviseHarness({ executable: node, args, cwd: runtimeRoot === undefined ? harnessRoot : join(runtimeRoot, 'dsh'), env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSHPILOT_REMOTE_CONTROL: '1', DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING: '1', DSHPILOT_REMOTE_PRINT_PAIRING: '1', DSHPILOT_APP_DATA: dataRoot } })
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
