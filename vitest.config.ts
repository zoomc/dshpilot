import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['vendor/**', '**/node_modules/**', '**/target/**', '**/artifacts/**'],
  },
})
