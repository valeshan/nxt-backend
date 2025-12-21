import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['dotenv/config', './tests/setupEnv.ts'],
    fileParallelism: false, // Disable parallel execution of test files to avoid DB conflicts
  },
});
