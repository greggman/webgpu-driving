// Build script: bundles src/main.ts (+ .wgsl as text) into dist/.
//   node build.mjs          -> production build
//   node build.mjs --watch  -> rebuild on change
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await fs.mkdir('dist', {recursive: true});
await fs.copyFile('index.html', 'dist/index.html');
// Social media preview image (see the og: / twitter: tags in index.html).
await fs.copyFile(
  'screenshots/webgpu-driving-country.jpg',
  'dist/webgpu-driving-country.jpg',
);

const options = {
    // The car mesh worker is its own bundle (dist/meshWorker.js).
  entryPoints: {main: 'src/main.ts', meshWorker: 'src/gen/meshWorker.ts'},
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: 'dist',
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
