// In-page interleaved A/B of `debug` variants: one page switches the debug
// URL parameter every 1.5 s (the renderer reads it each frame) and reports
// each variant's median GPU span. GPU timing here drifts by a millisecond or
// more between runs (clocks, heat), which interleaving cancels out.
//   node test/ab.js 'biome=forest&seed=1&s=600&freeze=1' base noprepass ...
//     [--size WxH]
// (`base` = no debug flags; build first with `npm run build`.)
import puppeteer from 'puppeteer';
import {startServer} from './server.js';
const args = process.argv.slice(2);
const si = args.indexOf('--size');
const [W, H] = (si >= 0 ? args.splice(si, 2)[1] : '1280x720').split('x').map(Number);
const [params, ...variants] = args;
const server = await startServer(8127);
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
await page.setViewport({width: W, height: H});
await page.goto(`http://localhost:8127/?hud=0&${params}`);
await new Promise(r => setTimeout(r, 6000));
const res = Object.fromEntries(variants.map(v => [v, []]));
for (let round = 0; round < 15; ++round) {
  for (const v of variants) {
    await page.evaluate(v => {
      const u = new URL(location.href);
      u.searchParams.set('debug', v === 'base' ? '' : v);
      history.replaceState(null, '', u);
    }, v);
    await new Promise(r => setTimeout(r, 1500));
    res[v].push(await page.evaluate(() => window.__dev.stats().gpu.span));
  }
}
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const v of variants) console.log(v.padEnd(12), 'median', med(res[v]).toFixed(2), 'min', Math.min(...res[v]).toFixed(2));
await browser.close(); server.close();
