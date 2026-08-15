import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RuntimePointers, SupervisorCore, isLoopbackUrl, parseReadinessUrl, resolveAppDataPaths, type RuntimeManifest,
  downloadAndInstallRuntime, runtimeManifestSigningPayload, sha256File, validateRuntimeManifest, verifyRuntimeArtifact, verifyRuntimeManifestSignature,
} from './index.js'

function manifest(version: string): RuntimeManifest {
  return {
    schemaVersion: 1 as const, channel: 'tested' as const, runtimeVersion: version,
    upstream: { repository: 'https://github.com/deepseek-ai/deepseek-harness', ref: 'master', sha: 'a'.repeat(40), version: '0.1.0-rc.5' },
    node: { version: '22.22.3', platform: 'darwin', arch: 'arm64' },
    artifact: { url: 'https://example.invalid/runtime.tar.gz', size: 0, sha256: '0'.repeat(64), signature: 'AA==' },
    generatedAt: '2026-08-15T00:00:00.000Z',
  }
}

describe('readiness and manifest guards', () => {
  it('accepts only a loopback HTTP readiness URL', () => {
    expect(parseReadinessUrl('dsh web: http://127.0.0.1:43123')).toBe('http://127.0.0.1:43123')
    expect(isLoopbackUrl('http://localhost:43123')).toBe(false)
    expect(parseReadinessUrl('dsh web: http://0.0.0.0:43123')).toBeUndefined()
  })

  it('rejects an unsigned or malformed manifest', () => {
    expect(() => validateRuntimeManifest({ ...manifest('one'), artifact: { ...manifest('one').artifact, sha256: 'bad' } })).toThrow('sha256')
  })
})

describe('runtime pointers', () => {
  it('keeps current and previous and supports rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-pointers-'))
    const pointers = new RuntimePointers(resolveAppDataPaths(root))
    await pointers.promote(manifest('one'))
    await pointers.promote(manifest('two'))
    expect((await pointers.current())?.runtimeVersion).toBe('two')
    expect((await pointers.previous())?.runtimeVersion).toBe('one')
    expect((await pointers.rollback()).runtimeVersion).toBe('one')
    expect((await pointers.current())?.runtimeVersion).toBe('one')
  })

  it('recovers an interrupted pointer transaction before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-pointer-recovery-'))
    const paths = resolveAppDataPaths(root)
    const pointers = new RuntimePointers(paths)
    await pointers.promote(manifest('healthy'))
    await writeFile(join(paths.runtime, 'pointers.transaction.json'), JSON.stringify({ current: manifest('healthy') }))
    await writeFile(paths.current, JSON.stringify(manifest('corrupt-intermediate')))
    expect((await pointers.current())?.runtimeVersion).toBe('healthy')
  })
})

describe('artifact verification', () => {
  it('verifies SHA-256 and Ed25519 signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-artifact-'))
    const artifact = join(root, 'runtime.bin')
    await writeFile(artifact, 'phase-1-runtime')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const data = Buffer.from('phase-1-runtime')
    const signature = sign(null, data, privateKey).toString('base64')
    const current = manifest('signed')
    current.artifact.size = data.length
    current.artifact.sha256 = await sha256File(artifact)
    current.artifact.signature = signature
    current.manifestSignature = { algorithm: 'Ed25519', keyId: 'test', value: sign(null, Buffer.from(runtimeManifestSigningPayload(current)), privateKey).toString('base64') }
    verifyRuntimeManifestSignature(current, publicKey.export({ format: 'pem', type: 'spki' }).toString())
    await verifyRuntimeArtifact(artifact, current, publicKey.export({ format: 'pem', type: 'spki' }).toString())
  })
})

describe('runtime update transaction', () => {
  it('downloads, verifies, smoke-tests, promotes, and cleans staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpilot-update-'))
    const pointers = new RuntimePointers(resolveAppDataPaths(root))
    const bytes = Buffer.from('runtime-archive')
    const next = manifest('next')
    next.artifact.size = bytes.length
    next.artifact.sha256 = createHash('sha256').update(bytes).digest('hex')
    next.artifact.signature = 'UNSIGNED-LOCAL'
    await downloadAndInstallRuntime(next, pointers, {
      publicKey: 'unused', allowUnsignedLocal: true,
      fetchImpl: async () => new Response(bytes, { status: 200 }),
      extract: async (_archive, staging) => { await mkdir(staging, { recursive: true }); await writeFile(join(staging, 'node'), 'fake-node') },
      smoke: async staging => { await expect(readFile(join(staging, 'node'), 'utf8')).resolves.toBe('fake-node') },
    })
    expect((await pointers.current())?.runtimeVersion).toBe('next')
    expect(await readdir(resolveAppDataPaths(root).staging)).toEqual([])
  })
})

describe('supervisor state machine', () => {
  it('backs off exponentially and fails after the configured limit', async () => {
    const delays: number[] = []
    const supervisor = new SupervisorCore({ maxRestarts: 3, sleep: async delay => { delays.push(delay) } })
    supervisor.starting(); supervisor.ready('http://127.0.0.1:1', 123)
    expect(await supervisor.unexpectedExit('crash')).toBe(true)
    expect(await supervisor.unexpectedExit('crash')).toBe(true)
    expect(await supervisor.unexpectedExit('crash')).toBe(true)
    expect(await supervisor.unexpectedExit('crash')).toBe(false)
    expect(delays).toEqual([1000, 2000, 4000])
    expect(supervisor.status.state).toBe('failed')
  })
})
