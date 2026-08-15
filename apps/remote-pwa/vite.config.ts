import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)))
export default defineConfig({ root, plugins: [react()], build: { outDir: resolve(root, '../../dist/remote-pwa'), emptyOutDir: true } })
