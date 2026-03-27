import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['bin/duck.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist/bin',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
})
