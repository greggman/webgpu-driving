// Keyboard regression checks: C cycles camera modes, number keys switch
// environment without changing the camera mode, V cycles the player car.
//   node test/keys.js
import puppeteer from 'puppeteer';
import {startServer} from './server.js';

const server = await startServer(8125);
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
await page.setViewport({width: 960, height: 540});
page.on('console', e => {
  if (e.type() === 'error' || e.text().includes('[gpu-error]'))
    console.log('[page]', e.text().slice(0, 300));
});
await page.goto('http://localhost:8125/?biome=country&seed=5&hud=0');
await page.waitForFunction('window.__dev && window.__dev.settled', {
  timeout: 30000,
});
const get = e => page.evaluate(e);
const forced = () => get('window.__dev.app.director.forced');
let fail = 0;
const expect = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}`);
};
expect('starts on auto', await forced(), null);
await page.keyboard.press('c');
expect('C -> chase', await forced(), 'chase');
await page.keyboard.press('c');
expect('C -> helicopter', await forced(), 'helicopter');
await page.keyboard.press('2');
await page.waitForFunction(
  "window.__dev.app.biome.id !== 'country' && !window.__dev.app.busy",
  {timeout: 60000},
);
expect('biome switch keeps camera', await forced(), 'helicopter');
const k0 = await get('window.__dev.app.playerCar');
await page.keyboard.press('v');
const k1 = await get('window.__dev.app.playerCar');
expect('V changes car', k0 !== k1, true);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
