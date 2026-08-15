import { defineConfig } from 'tsdown'

/**
 * DSHPilot Client Plugin browser bundle.
 *
 * Mirrors the upstream DeepSeek Harness `clientConfig` contract: the bundle is a
 * CJS closure-factory that registers itself through the web-shell
 * `window.__ModuleLoader__.load({ id, factory })` sink. `react` and the
 * `@deepseek-ai/*` platform seed modules stay EXTERNAL (resolved by the loader's
 * module table — inlining them would duplicate React and break hooks); everything
 * else (including the Tauri browser bridges, which the desktop webview injects as
 * `window.__TAURI__`) is inlined so the bundle is self-contained.
 */
const id = '@dshpilot/dsh-client-desktop'

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const CLIENT_EXTERNALS: string[] = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

export default defineConfig({
  name: `${id}/client`,
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: CLIENT_EXTERNALS,
    alwaysBundle: (moduleId: string) => !CLIENT_EXTERNALS.includes(moduleId),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)`,
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    exports: 'named',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
