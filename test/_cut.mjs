import puppeteer from 'puppeteer';
import {startServer} from './server.js';
const server = await startServer(8135);
const browser = await puppeteer.launch({headless: true});
for (const [s, cam] of [[2600,'chase'],[7850,'chase'],[7850,'interior'],[2600,'interior']]) {
  const page = await browser.newPage();
  await page.setViewport({width: 1280, height: 720});
  await page.goto(`http://localhost:8135/?hud=0&biome=bigsur&seed=1&s=${s}&cam=${cam}&freeze=1`);
  await page.waitForFunction(() => window.__dev?.ready && !window.__dev.app.showingProgress, {timeout: 120000});
  await new Promise(r => setTimeout(r, 4000));
  const st = await page.evaluate(() => window.__dev.stats());
  const g = st.gpu;
  const top = Object.entries(g).filter(([k]) => k !== 'total' && k !== 'span').sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
  console.log(`s=${s} ${cam.padEnd(9)} span ${g.span?.toFixed(2)}  terrain ${st.terrainNodes} chunks ${st.roadChunks} | ${top}`);
  await page.screenshot({path: `screenshots/cut-${s}-${cam}.png`});
  await page.close();
}
await browser.close(); server.close();
