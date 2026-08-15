import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const controlContractsSource = fileURLToPath(new URL('./packages/control-contracts/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dshpilot/control-contracts': controlContractsSource,
    },
  },
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['vendor/**', '**/node_modules/**', '**/target/**', '**/artifacts/**'],
  },
})
