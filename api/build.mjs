// Bundles the API into one file for Azure Functions, so the deployed package needs no node_modules.
import { build } from 'esbuild';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';

const out = 'dist';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: ['src/functions.ts'],
  outfile: `${out}/functions.js`,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'linked',
  // Provided by the Functions worker at runtime.
  external: ['@azure/functions-core'],
  // Some bundled dependencies still call require(); give ESM a working one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { 'process.env.GIT_SHA': JSON.stringify(process.env.GIT_SHA ?? 'local') },
  logLevel: 'info',
});

await copyFile('host.json', `${out}/host.json`);
await writeFile(
  `${out}/package.json`,
  JSON.stringify({ name: 'invoicepilot-api', type: 'module', main: 'functions.js' }, null, 2) + '\n',
);
