import { defineConfig } from 'vitest/config';

// Separate from vite.config.js on purpose: that file sets `root: 'web'` to
// serve the dashboard, which made vitest look for tests inside web/ and find
// none. Vitest prefers this file, so the two configs stay out of each other's
// way.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
