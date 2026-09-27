// Startup smoothness: loads each environment, waits until the world is
// running, then records frame intervals for a few seconds and reports the
// long frames (main-thread stalls such as on-demand asset builds).
//   node test/hitch.js [biome...] [--secs N]
import puppeteer from 'puppeteer';
import {startServer} from './server.js';

const args = process.argv.slice(2);
const si = args.indexOf('--secs');
const secs = si >= 0 ? Number(args.splice(si, 2)[1]) : 10;
const biomes = args.length ? args : ['country', 'desert', 'forest'];
const server = await startServer(Number(process.env.SHOOT_PORT) || 8127);
const browser = await puppeteer.launch({headless: true});
for (const b of biomes) {
  const page = await browser.newPage();
  await page.setViewport({width: 1280, height: 720});
  await page.goto(`http://localhost:8127/?hud=0&biome=${b}`);
  await page.waitForFunction(() => window.__dev?.ready, {timeout: 120000});
  const gaps = await page.evaluate(
    secs =>
      new Promise(res => {
        const out = [];
        let last = performance.now();
        const t0 = last;
        const tick = now => {
          out.push(now - last);
          last = now;
          if (now - t0 < secs * 1000) requestAnimationFrame(tick);
          else res(out);
        };
        requestAnimationFrame(tick);
      }),
    secs,
  );
  const long = gaps.filter(g => g > 100);
  const sorted = [...gaps].sort((a, c) => c - a);
  console.log(
    `${b.padEnd(10)} frames ${gaps.length}  worst ${sorted
      .slice(0, 3)
      .map(g => g.toFixed(0))
      .join(', ')} ms  >100ms: ${long.length}`,
  );
  await page.close();
}
await browser.close();
server.close();
