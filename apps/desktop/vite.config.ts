import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Do not empty the output dir on each build. The sandbox build runner guards
    // bulk deletes, so clearing the dir here would block incremental rebuilds.
    emptyOutDir: false,
  },
})
