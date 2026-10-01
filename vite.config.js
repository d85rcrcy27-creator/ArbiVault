import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('/react/')) {
            return 'react-vendor';
          }
          if (id.includes('@radix-ui')) return 'radix-ui';
          if (
            id.includes('framer-motion') ||
            id.includes('clsx') ||
            id.includes('class-variance-authority')
          ) {
            return 'ui-utils';
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: true,
    port: 3000,
    strictPort: false,
  },
  preview: {
    port: 4173,
    strictPort: false,
  },
})
