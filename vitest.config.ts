import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Canvas/rAF-driven presentational components are intentionally untested: they
      // render decorative visuals (WebGL/canvas backdrops, requestAnimationFrame
      // count-up/reveal animations) with no branching logic worth asserting, and jsdom
      // cannot exercise canvas/rAF meaningfully. Excluded from coverage to keep the
      // thresholds honest.
      exclude: [
        'src/app/HeroBackdrop.tsx',
        'src/app/dashboard/DashboardBackdrop.tsx',
        'src/app/CountUp.tsx',
        'src/app/Reveal.tsx',
        'src/app/ProductPanel.tsx',
      ],
      // Ratchet thresholds set from the first measured run (lines 69.89%,
      // branches 85.12%) minus a 2-percentage-point buffer: floor(measured) - 2.
      thresholds: {
        lines: 67,
        branches: 83,
      },
    },
  },
});
