/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: mode === 'lib'
    ? {
        outDir: 'dist',
        lib: { entry: 'src/lib-entry.ts', formats: ['es'], fileName: () => 'vanilla-data-grid.js' },
      }
    : { outDir: 'dist-demo' },
  worker: { format: 'es' },
  test: { environment: 'jsdom' },
}));
