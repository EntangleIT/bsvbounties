import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    proxy: {
      // Point at API (override with VITE_API_PROXY if needed)
      '/v1': process.env.VITE_API_PROXY ?? 'http://localhost:8787',
      '/health': process.env.VITE_API_PROXY ?? 'http://localhost:8787',
      '/openapi.json': process.env.VITE_API_PROXY ?? 'http://localhost:8787',
      '/.well-known': process.env.VITE_API_PROXY ?? 'http://localhost:8787',
    },
  },
})
