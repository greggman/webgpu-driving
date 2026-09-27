// Load-time trace: opens the app and prints each loading-screen step with
// the time it appeared, then the time until the world is running.
//   node test/loadtime.js [biome]
import puppeteer from 'puppeteer';
import {startServer} from './server.js';
const server = await startServer(8129);
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
await page.setViewport({width: 1280, height: 720});
const t0 = Date.now();
const labels = [];
page.on('console', m => { const t = m.text(); if (t.startsWith('[timing]')) labels.push(`${Date.now() - t0}ms ${t}`); });
await page.exposeFunction('__lbl', s => labels.push(`${Date.now() - t0}ms LABEL ${s}`));
await page.evaluateOnNewDocument(() => {
  const obs = () => { const el = document.getElementById('loading-label'); if (!el) return setTimeout(obs, 10);
    new MutationObserver(() => window.__lbl(el.textContent)).observe(el, {childList: true, characterData: true, subtree: true}); };
  obs();
});
await page.goto(`http://localhost:8129/?hud=0&biome=${process.argv[2] ?? 'country'}&timing=1`);
await page.waitForFunction(() => window.__dev?.ready && !window.__dev.app.showingProgress, {timeout: 180000});
console.log(`ready at ${Date.now() - t0} ms`);
let prev = '';
for (const l of labels) { const k = l.replace(/^\d+ms /, '').replace(/\d+ \/ \d+/, 'n/m').replace(/^LABEL \d+%/, 'LABEL'); if (k !== prev) console.log(l); prev = k; }
await browser.close(); server.close();
