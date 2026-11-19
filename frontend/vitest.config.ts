import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Тесты — на демо-данных, как в CI. Иначе VITE_PIPELINE_URL из локального .env включал живой режим,
    // и при запуске из корня экраны ждали API вместо макета. Живой режим тесты включают сами (vi.mock env).
    env: { VITE_PIPELINE_URL: '' },
  },
});
