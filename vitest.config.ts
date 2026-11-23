import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/*.spec.ts',
      'firestore.rules.test.js',
    ],
  },
});
