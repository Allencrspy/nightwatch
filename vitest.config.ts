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

    // The suite must not depend on whoever's .env happens to be on disk.
    // With real credentials present, the "login returns 503 when not
    // configured" test instead called Dhan for real, succeeded, and left a
    // pending login behind — which then broke the callback test after it.
    // dotenv does not override variables already set, so blanking them here
    // wins over .env and keeps every run deterministic.
    env: {
      NODE_ENV: 'test',
      DHAN_API_KEY: '',
      DHAN_API_SECRET: '',
      DHAN_CLIENT_ID: '',
      OPENAI_API_KEY: '',
      // Never touch the real session file from a test run.
      SESSION_STORE_PATH: '.sessions.test.json',
      PLAN_HISTORY_PATH: '.plan-history.test.json',
    },
  },
});
