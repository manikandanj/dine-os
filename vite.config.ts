import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
const env = loadEnv('development', '.', 'DINEOS_');
export default defineConfig({ plugins: [react()], server: {port:5174, strictPort:true, proxy:{'/api':env.DINEOS_API_PROXY ?? 'http://127.0.0.1:8001'}}, test:{environment:'jsdom',setupFiles:'./src/test/setup.ts'} });
