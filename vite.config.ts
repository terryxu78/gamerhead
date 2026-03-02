import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    // Load env file based on `mode` in the current working directory.
    const env = loadEnv(mode, '.', '');
    
    return {
      server: {
        middlewareMode: false,
        proxy: {
          // Proxy API requests to the backend server if running via 'vite' cli (fallback)
          '/api': {
            target: 'http://localhost:8080',
            changeOrigin: true,
            secure: false,
          }
        }
      },
      plugins: [react()],
      // Note: We intentionally DO NOT define process.env.API_KEY here for production.
      // This forces the frontend code to rely on the window.GEMINI_API_KEY injected by server.js.
      resolve: {
        alias: {
          '@': path.resolve('.'),
        }
      }
    };
});