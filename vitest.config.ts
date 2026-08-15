import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const controlContractsSource = fileURLToPath(new URL('./packages/control-contracts/src/index.ts', import.meta.url))
const desktopHostSource = fileURLToPath(new URL('./packages/desktop-host/src/index.ts', import.meta.url))
const remoteDaemonSource = fileURLToPath(new URL('./packages/remote-daemon/src/index.ts', import.meta.url))
const remoteClientSource = fileURLToPath(new URL('./packages/remote-client/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dshpilot/control-contracts': controlContractsSource,
      '@dshpilot/desktop-host': desktopHostSource,
      '@dshpilot/remote-daemon': remoteDaemonSource,
      '@dshpilot/remote-client': remoteClientSource,
    },
  },
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['vendor/**', '**/node_modules/**', '**/target/**', '**/artifacts/**'],
  },
})
