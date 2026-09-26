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
// Orbit camera: a drag on the canvas switches to it and turns the view,
// the wheel dollies, arrows move the focus (limited).
await page.mouse.move(480, 270);
await page.mouse.down();
await page.mouse.move(560, 250, {steps: 5});
await page.mouse.up();
expect('drag -> orbit', await forced(), 'orbit');
const d0 = await get('window.__dev.app.director.orbit.dist');
await page.mouse.wheel({deltaY: -300});
const d1 = await get('window.__dev.app.director.orbit.dist');
expect('wheel dollies in', d1 < d0, true);
for (let i = 0; i < 40; ++i) await page.keyboard.press('ArrowLeft');
const f = await get('window.__dev.app.director.orbit.focus');
expect('focus limited to 10 m', Math.hypot(f[0], f[1], f[2] - 0.8) <= 10.001, true);
await new Promise(r => setTimeout(r, 500));
const cam = await get('window.__dev.app.lastCamera');
const gnd = await get(
  `window.__dev.app.road.groundHeight(${cam.eye[0]}, ${cam.eye[2]})`,
);
expect('orbit eye above ground', cam.eye[1] > gnd, true);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
