import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
    reporters: ['verbose', 'junit'],
    outputFile: { junit: `reports/${process.env.TEST_PHASE || 'local'}-junit.xml` },
    coverage: {
      provider: 'v8',
      // Explicit component scope; integration separately executes the whole bundle.
      include: ['src/utils/templateEngine.js'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: { lines: 95, statements: 95, functions: 100, branches: 90 },
    },
  },
});
