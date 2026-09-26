// Deterministic screenshot harness.
//
//   node test/shoot.js [filter] [--out dir] [--size WxH]
//
// Serves dist/ with express, loads each entry of test/shots.json in headless
// Chrome (no special flags needed for WebGPU), waits for window.__dev.settled,
// and screenshots the canvas element. Fails on any [gpu-error] console line,
// page error, or a blank (single-color) frame.
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import {startServer} from './server.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const outDir = path.resolve(flag('--out', path.join(here, '..', 'screenshots')));
const [W, H] = flag('--size', '1280x720').split('x').map(Number);
const extra = flag('--params', '');
const filter = args[0];

const shots = JSON.parse(await fs.readFile(path.join(here, 'shots.json'), 'utf8'))
  .filter(s => !filter || s.name.includes(filter));
await fs.mkdir(outDir, {recursive: true});

const port = 8123;
const server = await startServer(port);
const browser = await puppeteer.launch({headless: true, args: []});
const report = [];
let failed = false;

for (const shot of shots) {
  const page = await browser.newPage();
  await page.setViewport({width: W, height: H});
  const errors = [];
  page.on('console', e => {
    const t = e.text();
    if (t.includes('[gpu-error]')) errors.push(t);
    if (e.type() === 'error' || t.includes('[gpu-error]') || t.startsWith('[log]')) {
      console.log(`  [${shot.name}] ${t}`);
    }
  });
  page.on('pageerror', e => {
    errors.push(e.message);
    console.log(`  [${shot.name}] pageerror: ${e.message}`);
  });
  const q = new URLSearchParams({...shot.params, freeze: '1', hud: '0'});
  if (extra) for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/?${q}`, {waitUntil: 'load'});
  let stats = null;
  try {
    await page.waitForFunction('window.__dev && window.__dev.settled', {
      timeout: 60000,
      polling: 100,
    });
    stats = await page.evaluate(() => window.__dev.stats?.() ?? null);
  } catch (e) {
    errors.push(`timeout waiting for settled: ${e.message}`);
  }
  const file = path.join(outDir, `${shot.name}.png`);
  const el = await page.$('#screen');
  await el.screenshot({path: file});

  // Blank-frame check: sample the screenshot through the page canvas.
  const variance = await page.evaluate(async () => {
    const c = document.getElementById('screen');
    const bmp = await createImageBitmap(c);
    const oc = new OffscreenCanvas(64, 36);
    const ctx = oc.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0, sum2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] + d[i + 1] + d[i + 2];
      sum += l; sum2 += l * l;
    }
    const n = d.length / 4;
    return sum2 / n - (sum / n) ** 2;
  });
  if (variance < 1) errors.push(`blank frame (variance ${variance.toFixed(2)})`);
  const ms = Date.now() - t0;
  report.push({name: shot.name, params: shot.params, errors, stats, ms});
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${shot.name} (${ms} ms)${stats ? ' ' + JSON.stringify(stats) : ''}`);
  for (const e of errors) console.log(`     ${e}`);
  if (errors.length) failed = true;
  await page.close();
}

await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
