// Soak test: drives each environment at an accelerated clock (default 8x)
// for N seconds, exercising streaming, origin rebasing, road-window shifts
// and clipmap recentering; fails on any GPU error or page error.
//   node test/soak.js [biome...] [--secs N] [--speed N]
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import {startServer} from './server.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const secs = Number(opt('--secs', 40));
const speed = Number(opt('--speed', 8));
const biomes = args.length ? args : ['country', 'coast', 'forest'];
const server = await startServer(8128);
const browser = await puppeteer.launch({headless: true});
await fs.mkdir('screenshots', {recursive: true});
let failed = false;
for (const b of biomes) {
  const page = await browser.newPage();
  await page.setViewport({width: 1280, height: 720});
  const errors = [];
  page.on('console', e => {
    if (e.text().includes('[gpu-error]')) errors.push(e.text().slice(0, 300));
  });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:8128/?hud=0&biome=${b}&speed=${speed}`);
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < secs * 1000) {
    await new Promise(r => setTimeout(r, 5000));
    samples.push(
      await page.evaluate(() => ({
        fps: Math.round(window.__dev.app.fps),
        s: Math.round(window.__dev.app.traffic.player.s),
        shot: window.__dev.app.lastCamera?.shot,
      })),
    );
  }
  await page.screenshot({path: `screenshots/soak-${b}.png`});
  const last = samples[samples.length - 1];
  console.log(
    `${errors.length ? 'FAIL' : 'ok  '} ${b}: drove to s=${last.s} m, fps ${samples.map(x => x.fps).join('/')}, shots ${[...new Set(samples.map(x => x.shot))].join(',')}`,
  );
  for (const e of [...new Set(errors)].slice(0, 5)) console.log('     ' + e);
  if (errors.length) failed = true;
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
