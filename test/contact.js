// Builds a labeled contact sheet from screenshots/*.png.
//   node test/contact.js [filter] [--cols N] [--out file]
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const cols = Number(opt('--cols', 2));
const dir = path.resolve(opt('--dir', 'screenshots'));
const out = path.resolve(opt('--out', path.join(dir, 'contact.png')));
const filter = args[0];
const files = (await fs.readdir(dir))
  .filter(f => f.endsWith('.png') && !f.startsWith('contact') && (!filter || filter.split(',').some(x => (x.startsWith('^') ? f.startsWith(x.slice(1)) : f.includes(x)))))
  .sort();
const W = 640, H = 360;
const cells = await Promise.all(files.map(async f => {
  const b64 = (await fs.readFile(path.join(dir, f))).toString('base64');
  return `<div class=c><img src="data:image/png;base64,${b64}"><span>${f}</span></div>`;
}));
const html = `<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${W}px);gap:2px}
.c{position:relative;width:${W}px;height:${H}px}img{width:100%;height:100%}
span{position:absolute;left:4px;top:2px;color:#fff;font:12px sans-serif;text-shadow:0 0 3px #000}</style>${cells.join('')}`;
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
const rows = Math.ceil(files.length / cols);
await page.setViewport({width: cols * (W + 2), height: rows * (H + 2)});
await page.setContent(html);
await page.screenshot({path: out});
await browser.close();
console.log(`wrote ${out} (${files.length} images)`);
