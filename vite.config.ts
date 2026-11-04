import { defineConfig } from 'vitest/config';

// SharedArrayBuffer (world storage shared with workers) requires cross-origin isolation.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5173, strictPort: true, headers: isolationHeaders },
  preview: { port: 4173, strictPort: true, headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
  // Generation and meshing tests are CPU-heavy and the suite runs files in parallel.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
});
