// Loads the app with a query string, waits until settled, evaluates a JS
// expression in the page and prints the JSON result.
//   node test/probe.js "biome=snow&cam=interior" "window.__dev.stats()"
import puppeteer from 'puppeteer';
import {startServer} from './server.js';

const [query = '', expr = 'window.__dev.stats()'] = process.argv.slice(2);
const server = await startServer(8124);
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
await page.setViewport({width: 1280, height: 720});
page.on('console', e => {
  const t = e.text();
  if (e.type() === 'error' || t.includes('[gpu-error]')) console.log('[page]', t.slice(0, 400));
});
await page.goto(`http://localhost:8124/?freeze=1&hud=0&${query}`);
await page.waitForFunction('window.__dev && window.__dev.settled', {timeout: 25000});
const r = await page.evaluate(async e => JSON.stringify(await eval(e), null, 1), expr);
console.log(r);
await browser.close();
server.close();
