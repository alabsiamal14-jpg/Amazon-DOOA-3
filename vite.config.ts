import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
          manualChunks(id) {
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/') ||
              id.includes('\\node_modules\\react\\') ||
              id.includes('\\node_modules\\react-dom\\') ||
              id.includes('\\node_modules\\scheduler\\')
            ) {
              return 'vendor-react';
            }

            if (id.includes('node_modules')) {
              if (id.includes('/node_modules/firebase/') || id.includes('/node_modules/@firebase/')) {
                return 'vendor-firebase';
              }

              if (
                id.includes('react-simple-maps') ||
                id.includes('/node_modules/d3-') ||
                id.includes('topojson')
              ) {
                return 'vendor-maps';
              }

              if (id.includes('lucide-react')) {
                return 'vendor-icons';
              }

              if (id.includes('@supabase')) {
                return 'vendor-supabase';
              }

              return 'vendor-libs';
            }
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      fs: {
        deny: ['.env', '.env.*', '**/backups/**', '**/data/**', '**/scripts/**'],
      },
    },
  };
});

