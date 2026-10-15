import { defineConfig } from 'vitest/config'

export default defineConfig({
  // streamdown ships its own React copy; keep a single one (as vite.config.ts does).
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: ['streamdown'] } },
  },
})
