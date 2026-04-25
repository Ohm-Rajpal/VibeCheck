import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds a single self-contained HTML/JS bundle that the extension
// can inline into webview.html.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
