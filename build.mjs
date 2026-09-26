// Build script: bundles src/main.ts (+ .wgsl as text) into dist/.
//   node build.mjs          -> production build
//   node build.mjs --watch  -> rebuild on change
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await fs.mkdir('dist', {recursive: true});
await fs.copyFile('index.html', 'dist/index.html');

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/main.js',
  loader: {'.wgsl': 'text'},
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
