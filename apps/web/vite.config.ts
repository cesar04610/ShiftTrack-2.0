import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  root: 'apps/web',
  envDir: '../..',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Mostrador 2.0',
        short_name: 'Mostrador',
        lang: 'es',
        theme_color: '#111827',
        background_color: '#f3f4f6',
        display: 'standalone',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8080' } },
  preview: { port: 5173, host: '0.0.0.0', proxy: { '/api': 'http://127.0.0.1:8080' } },
});
