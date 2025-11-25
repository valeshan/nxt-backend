import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['dotenv/config'],
    fileParallelism: false, // Disable parallel execution of test files to avoid DB conflicts
  },
});
