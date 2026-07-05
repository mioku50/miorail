import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:8080';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Required for the Base Account popup (sign-in / connect / sendCalls).
      // `same-origin` would block the popup window; `same-origin-allow-popups`
      // lets it communicate back. See @base-org/account docs. Mirror this in
      // production via the edge/proxy that serves the built app.
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      },
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/health': {
          target: proxyTarget,
          changeOrigin: true,
        }
      }
    }
  };
})
