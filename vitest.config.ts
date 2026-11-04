import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/*.docker.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.int.test.ts', 'apps/*/src/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          globalSetup: ['./packages/db/src/testing/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'docker',
          include: ['packages/*/src/**/*.docker.test.ts', 'apps/*/src/**/*.docker.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 300_000,
          globalSetup: ['./packages/db/src/testing/global-setup.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
