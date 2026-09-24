import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发模式下 /api 代理到本地后端
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
