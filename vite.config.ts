import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolveBuildVersion } from './scripts/build-version.ts'

// Evaluated once by Vite; opening an already built app never recomputes this label.
const buildVersion = resolveBuildVersion()

export default defineConfig({
  plugins: [vue(), {
    name: 'fixed-build-info',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ buildVersion }) + '\n' })
    },
  }],
  define: { __BUILD_VERSION__: JSON.stringify(buildVersion) },
  base: './',
  server: { host: '0.0.0.0', port: 5190, strictPort: true },
  preview: { host: '0.0.0.0', port: 4190, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
})
