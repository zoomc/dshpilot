import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { globSync } from 'node:fs'
import { createHash, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function command(name: string, args: string[], cwd: string): string {
  const executable = process.platform === 'win32' && name === 'pnpm' ? 'pnpm.cmd' : name
  return execFileSync(executable, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: process.env.CI ?? 'true' } }).trim()
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

async function downloadNode(nodeVersion: string, destination: string): Promise<string> {
  const platform = process.platform === 'win32' ? 'win' : process.platform
  const arch = process.platform === 'win32' ? 'x64' : process.arch
  const extension = platform === 'win' ? 'zip' : 'tar.gz'
  const archiveName = `node-v${nodeVersion}-${platform}-${arch}.${extension}`
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`
  const archivePath = join(destination, archiveName)
  const archiveResponse = await fetch(`${baseUrl}/${archiveName}`)
  if (!archiveResponse.ok) throw new Error(`Node runtime download failed: HTTP ${archiveResponse.status}`)
  await writeFile(archivePath, Buffer.from(await archiveResponse.arrayBuffer()))
  const sumsResponse = await fetch(`${baseUrl}/SHASUMS256.txt`)
  if (!sumsResponse.ok) throw new Error(`Node runtime checksum download failed: HTTP ${sumsResponse.status}`)
  const expected = (await sumsResponse.text()).split('\n').find(line => line.endsWith(`  ${archiveName}`))?.split(' ')[0]
  if (!expected || await sha256(archivePath) !== expected) throw new Error('Node runtime checksum mismatch')
  const extracted = join(destination, `node-v${nodeVersion}-${platform}-${arch}`)
  await rm(extracted, { recursive: true, force: true }); await mkdir(extracted, { recursive: true })
  // Windows runners provide bsdtar even when the optional unzip utility is absent.
  // It can extract the Node zip archive and keeps the bundle script dependency-free.
  if (platform === 'win') execFileSync('tar', ['-xf', archivePath, '-C', destination])
  else execFileSync('tar', ['-xzf', archivePath, '-C', destination])
  const nodePath = platform === 'win' ? join(extracted, 'node.exe') : join(extracted, 'bin', 'node')
  return nodePath
}

async function materializeWorkspacePeers(deploymentRoot: string): Promise<void> {
  const packagePaths = globSync(['apps/*/package.json', 'packages/*/*/package.json', 'vendor/*/package.json'], { cwd: harnessRoot })
  const workspace = new Map<string, { path: string; manifest: PackageManifest }>()
  for (const relative of packagePaths) {
    const path = join(harnessRoot, relative)
    const manifest = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
    if (manifest.name) workspace.set(manifest.name, { path: dirname(path), manifest })
  }
  const cli = workspace.get('@deepseek-ai/dsh')
  if (!cli) throw new Error('unable to locate the upstream dsh workspace package')
  const queue = [
    ...Object.keys(cli.manifest.dependencies ?? {}),
    ...Object.keys(cli.manifest.devDependencies ?? {}),
    ...Object.keys(cli.manifest.optionalDependencies ?? {}),
  ]
  const seen = new Set<string>()
  const requiredWorkspacePackages = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index]
    if (!name || seen.has(name)) continue
    seen.add(name)
    const packageInfo = workspace.get(name)
    if (!packageInfo) continue
    requiredWorkspacePackages.add(name)
    const { manifest } = packageInfo
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional !== true && workspace.has(peer)) {
        queue.push(peer)
      }
    }
    queue.push(...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}))
  }
  for (const name of requiredWorkspacePackages) {
    const [scope, packageName] = name.startsWith('@') ? name.split('/') : ['', name]
    if (!packageName) continue
    const destination = join(deploymentRoot, 'node_modules', scope, packageName)
    try { await readFile(join(destination, 'package.json')); continue } catch { /* materialize below */ }
    const packageInfo = workspace.get(name)
    if (!packageInfo) continue
    await mkdir(destination, { recursive: true })
    for (const entry of ['package.json', 'lib', 'config', 'dist', 'assets']) {
      const source = join(packageInfo.path, entry)
      try { await cp(source, join(destination, entry), { recursive: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}

async function linkVirtualStorePackages(deploymentRoot: string): Promise<void> {
  const virtualStore = join(deploymentRoot, 'node_modules', '.pnpm')
  const rootModules = join(deploymentRoot, 'node_modules')
  for (const entry of await readdir(virtualStore)) {
    if (entry === 'node_modules') continue
    const packageModules = join(virtualStore, entry, 'node_modules')
    let names: string[]
    try { names = await readdir(packageModules) } catch { continue }
    for (const name of names) {
      const candidates = name.startsWith('@')
        ? (await readdir(join(packageModules, name))).map(child => join(name, child))
        : [name]
      for (const packageName of candidates) {
        const source = join(packageModules, packageName)
        try { await lstat(join(source, 'package.json')) } catch { continue }
        const target = join(rootModules, packageName)
        try { await lstat(target); continue } catch { /* create the missing root link */ }
        await mkdir(dirname(target), { recursive: true })
        await symlink(relative(dirname(target), source), target, process.platform === 'win32' ? 'junction' : 'dir')
      }
    }
  }
}

async function main(): Promise<void> {
  const output = resolve(argument('--output', join(projectRoot, 'artifacts', 'runtime')))
  const upstreamSha = command('git', ['rev-parse', 'HEAD'], harnessRoot)
  const upstreamVersion = JSON.parse(await readFile(join(harnessRoot, 'apps/cli/package.json'), 'utf8')).version as string
  const runtimeVersion = `${upstreamVersion}-${upstreamSha.slice(0, 12)}-${process.platform}-${process.arch}`
  const staging = join(output, 'staging', runtimeVersion)
  const runtimeRoot = join(staging, 'runtime')
  await rm(staging, { recursive: true, force: true })
  await mkdir(runtimeRoot, { recursive: true })

  command('pnpm', ['deploy', '--legacy', '--filter', '@deepseek-ai/dsh', join(runtimeRoot, 'dsh')], harnessRoot)
  await materializeWorkspacePeers(join(runtimeRoot, 'dsh'))
  await linkVirtualStorePackages(join(runtimeRoot, 'dsh'))
  const nodeVersion = process.env.DSHPILOT_NODE_VERSION ?? '22.19.0'
  const nodeArchiveRoot = join(output, 'node-cache')
  await mkdir(nodeArchiveRoot, { recursive: true })
  const nodePath = process.env.DSHPILOT_NODE_BINARY ?? await downloadNode(nodeVersion, nodeArchiveRoot)
  await copyFile(nodePath, join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node'))
  const archive = join(output, `${runtimeVersion}.tar.gz`)
  await mkdir(output, { recursive: true })
  execFileSync('tar', ['-czf', archive, '-C', staging, 'runtime'], { stdio: 'inherit' })
  const artifactSize = (await stat(archive)).size
  const artifactSha256 = await sha256(archive)
  const privateKeyPath = process.env.DSHPILOT_RUNTIME_PRIVATE_KEY
  const signature = privateKeyPath
    ? sign(null, await readFile(archive), await readFile(privateKeyPath)).toString('base64')
    : 'UNSIGNED-LOCAL'
  const manifest = {
    schemaVersion: 1 as const,
    channel: 'tested' as const,
    runtimeVersion,
    upstream: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      ref: 'master', sha: upstreamSha, version: upstreamVersion,
    },
    node: { version: nodeVersion, platform: process.platform, arch: process.arch },
    artifact: { url: `./${runtimeVersion}.tar.gz`, size: artifactSize, sha256: artifactSha256, signature },
    generatedAt: new Date().toISOString(),
  }
  await writeFile(join(output, `${runtimeVersion}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  const currentRoot = join(output, 'current')
  await rm(currentRoot, { recursive: true, force: true }); await mkdir(currentRoot, { recursive: true })
  await cp(runtimeRoot, join(currentRoot, 'versions', runtimeVersion), { recursive: true })
  await writeFile(join(output, 'current.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ archive, manifest: join(output, `${runtimeVersion}.json`), runtimeVersion }, null, 2))
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
