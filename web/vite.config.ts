/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm,tflite}'],
        // Precache only the SIMD MediaPipe runtime (every current browser); the
        // nosimd/module variants (~13 MB each, iOS < 16.4) are cached on first use.
        globIgnores: ['**/mediapipe/wasm/vision_wasm_nosimd_internal.*', '**/mediapipe/wasm/vision_wasm_module_internal.*'],
        runtimeCaching: [
          {
            urlPattern: /\/mediapipe\/wasm\/vision_wasm_(nosimd|module)_internal\.(js|wasm)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'mediapipe-fallback', expiration: { maxEntries: 4 } },
          },
        ],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
      manifest: {
        name: 'Magic Screen',
        short_name: 'Magic Screen',
        description: 'Make green screen magic! A kindergarten-friendly green screen studio.',
        theme_color: '#2f8fef',
        background_color: '#fff3cf',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
