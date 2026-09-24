import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { environment: 'node', exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
} as Parameters<typeof defineConfig>[0])
