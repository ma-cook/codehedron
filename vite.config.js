import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import glsl from 'vite-plugin-glsl';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
export default defineConfig({
  plugins: [react(), glsl(), wasm(), topLevelAwait()],
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  define: {
    global: 'globalThis',
  },
  build: {
    // Linked sourcemaps: freeze stacks in DevTools resolve to real functions
    // and files (the diffToHunks freeze was localized by manual debugger
    // pauses before this).
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      external: ['typescript'],
      output: {
        manualChunks: {
          'three-vendor': ['three', 'three-stdlib'],
          'react-vendor': ['react', 'react-dom'],

        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['three-stdlib'],
    include: ['draft-js'],
  },
    server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
