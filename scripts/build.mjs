// Builds the browser bundle into ./public (esbuild). The server itself needs no build step: Node 22.18+ runs the TypeScript directly.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('public', { recursive: true });
await build({ entryPoints: ['src/client/main.tsx'], bundle: true, outfile: 'public/app.js', format: 'esm', target: 'es2022', minify: !process.argv.includes('--dev'), sourcemap: process.argv.includes('--dev'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info' });
copyFileSync('src/client/styles.css', 'public/app.css'); copyFileSync('src/client/index.html', 'public/index.html');
