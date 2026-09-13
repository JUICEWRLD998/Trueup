import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The signature tests are the point of this suite; fail loudly if a file
    // silently collects zero tests.
    passWithNoTests: false,
  },
});
