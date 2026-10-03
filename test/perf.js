// Live performance run: drives each environment for a few seconds (not
// frozen) and reports frame rate and GPU pass timings.
//   node test/perf.js [biome...] [--secs N] [--size WxH] [--debug flags]
//     [--params 'seed=1&s=500'] [--all]
// (--params pins the world for A/B runs; --all lists every pass.)
import puppeteer from 'puppeteer';
import {startServer} from './server.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const secs = Number(opt('--secs', 8));
const debug = opt('--debug', '');
const extra = opt('--params', '');
const all = args.includes('--all');
if (all) args.splice(args.indexOf('--all'), 1);
const [W, H] = opt('--size', '1280x720').split('x').map(Number);
const biomes = args.length ? args : ['country', 'desert', 'coast', 'forest', 'snow', 'lahonda', 'night'];
const server = await startServer(8126);
const browser = await puppeteer.launch({headless: true});
for (const b of biomes) {
  const page = await browser.newPage();
  await page.setViewport({width: W, height: H});
  page.on('console', e => {
    if (e.text().includes('[gpu-error]')) console.log('  ', e.text().slice(0, 300));
  });
  await page.goto(
    `http://localhost:8126/?hud=0&biome=${b}&debug=${debug}${extra ? '&' + extra : ''}`,
  );
  await new Promise(r => setTimeout(r, secs * 1000));
  const s = await page.evaluate(() => ({fps: window.__dev.app.fps, st: window.__dev.stats()}));
  const g = s.st.gpu ?? {};
  const top = Object.entries(g)
    .filter(([k]) => k !== 'total' && k !== 'span')
    .sort((a, c) => c[1] - a[1])
    .slice(0, all ? undefined : 5)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ');
  console.log(`${(b + (debug ? ` [${debug}]` : '')).padEnd(30)} fps ${s.fps.toFixed(1).padStart(5)}  gpu span ${(g.span ?? 0).toFixed(2)} ms  [${top}]`);
  await page.close();
}
await browser.close();
server.close();
