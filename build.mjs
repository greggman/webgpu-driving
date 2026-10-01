// Build script: bundles src/main.ts (+ .wgsl as text) into dist/.
//   node build.mjs          -> production build
//   node build.mjs --watch  -> rebuild on change
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const watch = process.argv.includes('--watch');

await fs.mkdir('dist', {recursive: true});
await fs.copyFile('index.html', 'dist/index.html');
// Social media preview image (see the og: / twitter: tags in index.html).
await fs.copyFile(
  'screenshots/webgpu-driving-country.jpg',
  'dist/webgpu-driving-country.jpg',
);

// Strips comments (// and nestable /* */) and leading/trailing whitespace from
// WGSL, dropping blank lines. WGSL has no string literals, so this is safe.
// Line numbers in compile errors no longer match the .wgsl files, but the
// error logger (shaderModule) prints the offending line itself.
function minifyWGSL(src) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '*') {
      depth++;
      i++;
    } else if (depth > 0) {
      if (c === '*' && n === '/') {
        depth--;
        i++;
      }
    } else if (c === '/' && n === '/') {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else {
      out += c;
    }
  }
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

const wgslMinifyPlugin = {
  name: 'wgsl-minify',
  setup(build) {
    build.onLoad({filter: /\.wgsl$/}, async args => ({
      contents: minifyWGSL(await fs.readFile(args.path, 'utf8')),
      loader: 'text',
    }));
  },
};

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
  // Dev (watch) builds keep the WGSL as written so error line numbers match.
  plugins: watch ? [] : [wgslMinifyPlugin],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);

  // What a visitor downloads, gzipped (source maps and the social preview
  // image aren't fetched by the page).
  const kb = n => `${(n / 1024).toFixed(1)} KB`;
  let total = 0;
  for (const f of ['index.html', 'main.js', 'meshWorker.js']) {
    const data = await fs.readFile(`dist/${f}`);
    const size = zlib.gzipSync(data, {level: 9}).length;
    total += size;
    console.log(`  ${f.padEnd(16)} ${kb(size).padStart(10)} gzipped`);
  }
  console.log(`  ${'total'.padEnd(16)} ${kb(total).padStart(10)} gzipped`);
}
