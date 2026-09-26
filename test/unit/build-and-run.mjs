// Bundles test/unit/*.test.ts with esbuild and runs them with node:test.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const entries = fs.readdirSync('test/unit').filter(f => f.endsWith('.test.ts')).map(f => `test/unit/${f}`);
await esbuild.build({
  entryPoints: entries, bundle: true, platform: 'node', format: 'esm',
  outdir: 'build/unit', outExtension: {'.js': '.mjs'}, logLevel: 'warning',
  loader: {'.wgsl': 'text'},
});
const files = fs.readdirSync('build/unit').filter(f => f.endsWith('.mjs')).map(f => `build/unit/${f}`);
const r = spawnSync(process.execPath, ['--test', ...files], {stdio: 'inherit'});
process.exit(r.status ?? 1);
