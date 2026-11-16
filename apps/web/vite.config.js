import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PortsSchema = z.object({
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export default defineConfig(({ mode }) => {
  const ports = PortsSchema.parse({ ...loadEnv(mode, root, ''), ...process.env });
  return {
    envDir: root,
    plugins: [react(), tailwindcss()],
    resolve: { preserveSymlinks: true },
    server: {
      host: '127.0.0.1',
      port: ports.WEB_PORT,
      strictPort: true,
      proxy: {
        '/api': { target: 'http://127.0.0.1:' + ports.API_PORT },
      },
    },
    preview: { port: ports.WEB_PORT, strictPort: true },
  };
});
