import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPSTREAM_TESTED_SHA, UPSTREAM_TESTED_VERSION } from '../../packages/desktop-host/src/upstream.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessRoot = join(projectRoot, 'vendor', 'deepseek-harness')

type FailureClass = 'UPSTREAM_BUILD_BREAK' | 'CLIENT_SLOT_BREAK' | 'CLIENT_PLUGIN_API_BREAK' | 'HOST_PLUGIN_API_BREAK' | 'WEB_BOOT_BREAK' | 'DESKTOP_INTEGRATION_BREAK' | 'TEST_REGRESSION' | 'UNKNOWN'

function classify(output: string, stage: string): FailureClass {
  const text = `${stage}\n${output}`.toLowerCase()
  if (stage.startsWith('upstream-build')) return 'UPSTREAM_BUILD_BREAK'
  if (text.includes('ui-slot') || text.includes('ui slot')) return 'CLIENT_SLOT_BREAK'
  if (text.includes('client plugin') || text.includes('dsh-client-')) return 'CLIENT_PLUGIN_API_BREAK'
  if (text.includes('host plugin') || text.includes('dsh-host-')) return 'HOST_PLUGIN_API_BREAK'
  if (text.includes('readiness') || text.includes('dsh web') || text.includes('web smoke')) return 'WEB_BOOT_BREAK'
  if (text.includes('tauri') || text.includes('desktop')) return 'DESKTOP_INTEGRATION_BREAK'
  if (text.includes('test') || text.includes('vitest')) return 'TEST_REGRESSION'
  return 'UNKNOWN'
}

function run(name: string, command: string, args: readonly string[], cwd: string): string {
  return runWithEnv(name, command, args, cwd, {})
}

function runWithEnv(name: string, command: string, args: readonly string[], cwd: string, extraEnv: Record<string, string>): string {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    const classification = classify(output, name)
    throw new Error(`${classification}\n${name} failed (exit ${failure.status ?? 'unknown'})\n${output}`)
  }
}

async function main(): Promise<void> {
  if (process.env.DSHPILOT_UPSTREAM_CANDIDATE_SHA === undefined) {
    run('fetch-upstream', 'git', ['fetch', '--depth=1', 'origin', 'master'], harnessRoot)
  }
  const candidateSha = process.env.DSHPILOT_UPSTREAM_CANDIDATE_SHA
    ?? run('read-candidate', 'git', ['rev-parse', 'origin/master'], harnessRoot).trim()
  if (candidateSha !== UPSTREAM_TESTED_SHA) run('checkout-candidate', 'git', ['checkout', '--detach', candidateSha], harnessRoot)
  if (candidateSha === UPSTREAM_TESTED_SHA) {
    console.log(JSON.stringify({ status: 'NO_CHANGE', stableSha: UPSTREAM_TESTED_SHA, version: UPSTREAM_TESTED_VERSION }))
    return
  }
  const candidateVersion = JSON.parse(await readFile(join(harnessRoot, 'apps/cli/package.json'), 'utf8')).version as string
  const steps = [
    // The vendored Harness postinstall installs worktree-local lefthook config.
    // A submodule's common Git config cannot accept that mutation, so CI uses
    // npm's direct script/bin entry points after installing the vendor with
    // --ignore-scripts. This keeps upstream source untouched and reproducible.
    ['upstream-build', 'npm', ['run', 'typecheck'], harnessRoot],
    ['upstream-build', 'npm', ['run', 'build:lib'], harnessRoot],
    ['upstream-build-web', 'npm', ['--prefix', 'apps/web', 'run', 'build'], harnessRoot],
    ['harness-config', 'node', ['apps/cli/lib/bin.js', '--profile', 'web', '--dump-config'], harnessRoot],
    ['typecheck', 'pnpm', ['run', 'typecheck'], projectRoot],
    ['build', 'pnpm', ['run', 'build'], projectRoot],
    ['unit', 'pnpm', ['test'], projectRoot],
    ['web-smoke', 'pnpm', ['smoke'], projectRoot],
    ['desktop-integration', 'cargo', ['check', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml'], projectRoot],
    ['runtime-bundle', 'pnpm', ['runtime:bundle', '--', '--output', 'artifacts/guardian/runtime'], projectRoot],
  ] as const
  const diagnostics: string[] = []
  for (const [name, command, args, cwd] of steps) diagnostics.push(run(name, command, args, cwd))
  const runtimeManifest = JSON.parse(await readFile(join(projectRoot, 'artifacts', 'guardian', 'runtime', 'current.json'), 'utf8')) as { runtimeVersion: string }
  const packagedRoot = join(projectRoot, 'artifacts', 'guardian', 'runtime', 'current', 'versions', runtimeManifest.runtimeVersion)
  diagnostics.push(runWithEnv('packaged-web-smoke', 'pnpm', ['smoke'], projectRoot, { DSHPILOT_RUNTIME_ROOT: packagedRoot }))
  const report = { status: 'PASS', stableSha: UPSTREAM_TESTED_SHA, candidateSha, generatedAt: new Date().toISOString(), diagnostics: diagnostics.join('\n') }
  const reportDir = join(projectRoot, 'artifacts', 'guardian')
  await mkdir(reportDir, { recursive: true })
  await writeFile(join(reportDir, `${candidateSha}.json`), `${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--promote')) {
    const manifestPath = join(projectRoot, 'packages', 'desktop-host', 'src', 'upstream.ts')
    const manifest = await readFile(manifestPath, 'utf8')
    const promoted = manifest
      .replace(/UPSTREAM_TESTED_SHA = '[^']+'/u, `UPSTREAM_TESTED_SHA = '${candidateSha}'`)
      .replace(/UPSTREAM_TESTED_VERSION = '[^']+'/u, `UPSTREAM_TESTED_VERSION = '${candidateVersion}'`)
    await writeFile(manifestPath, promoted)
  }
  console.log(JSON.stringify({ status: 'PASS', stableSha: UPSTREAM_TESTED_SHA, candidateSha, candidateVersion, report: join(reportDir, `${candidateSha}.json`) }, null, 2))
}

void main().catch(error => { console.error(String(error)); process.exitCode = 1 })
