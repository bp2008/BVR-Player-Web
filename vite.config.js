import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The build must satisfy two deployment modes at once:
//   1. GitHub Pages (or any static host) -> full PWA, service worker, installable.
//   2. Double-clicking docs/index.html   -> file:// URL, no server, no fetch, no workers.
// Everything except the PWA side-files is therefore inlined into a single index.html.
export default defineConfig({
  base: './',
  plugins: [vue(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 4096,
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
})
