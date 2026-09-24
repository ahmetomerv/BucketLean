import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    coverage: {
      include: ['app/**/*.vue', 'server/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 75,
        lines: 85,
      },
    },
  },
})
