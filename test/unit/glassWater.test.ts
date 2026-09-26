import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GlassWater, WIPERS, Pane} from '../../src/sim/glassWater';

const PANES: Pane[] = [
  {uMin: -0.93, uMax: 0.93, vMax: 1.0},
  {uMin: -1.45, uMax: 0.86, vMax: 0.45},
  {uMin: -1.45, uMax: 0.86, vMax: 0.45},
];

function run(
  sim: GlassWater,
  secs: number,
  speed: number,
  rain: number,
  snow: number,
  wipers: boolean,
  t0 = 0,
) {
  const dt = 1 / 30;
  for (let t = t0; t < t0 + secs; t += dt)
    sim.update(dt, t, speed, rain, snow, wipers);
}

test('rain collects on the glass; parked, big drops run down', () => {
  const sim = new GlassWater(PANES, 3);
  run(sim, 6, 0, 1, 0, false);
  const ws = sim.drops.filter(d => d.pane === 0);
  assert.ok(ws.length > 100, `windshield drops: ${ws.length}`);
  // Everything that moves goes down the glass.
  let down = 0,
    up = 0;
  for (let i = 0; i < 30; ++i) {
    sim.update(1 / 30, 6 + i / 30, 0, 1, 0, false);
    for (const d of sim.drops) {
      if (d.pane !== 0) continue;
      if (d.dv < 0) down++;
      if (d.dv > 0) up++;
    }
  }
  assert.ok(down > 0 && down > up * 4, `down ${down} up ${up}`);
});

test('at speed the airflow pushes windshield drops up', () => {
  const sim = new GlassWater(PANES, 4);
  run(sim, 4, 30, 1, 0, false);
  let up = 0,
    down = 0;
  for (let i = 0; i < 30; ++i) {
    sim.update(1 / 30, 4 + i / 30, 30, 1, 0, false);
    for (const d of sim.drops) {
      if (d.pane !== 0) continue;
      if (d.dv > 0) up++;
      if (d.dv < 0) down++;
    }
  }
  assert.ok(up > down * 3, `up ${up} down ${down}`);
});

test('side-window drops run backward along varied paths', () => {
  const sim = new GlassWater(PANES, 5);
  run(sim, 4, 25, 1, 0, false);
  const angles: number[] = [];
  let back = 0,
    moving = 0;
  for (let i = 0; i < 30; ++i) {
    sim.update(1 / 30, 4 + i / 30, 25, 1, 0, false);
    for (const d of sim.drops) {
      if (d.pane === 0 || (d.du === 0 && d.dv === 0)) continue;
      moving++;
      if (d.du < 0) back++;
      angles.push(Math.atan2(d.dv, d.du));
    }
  }
  assert.ok(moving > 50 && back > moving * 0.9, `back ${back}/${moving}`);
  // Not a sliding texture: directions differ from drop to drop.
  const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
  const sd = Math.sqrt(
    angles.reduce((a, b) => a + (b - mean) ** 2, 0) / angles.length,
  );
  assert.ok(sd > 0.12, `direction spread ${sd.toFixed(3)} rad`);
  // Some drops are held (stick-slip) while others move.
  const held = sim.drops.filter(d => d.pane !== 0 && d.hold > 0).length;
  assert.ok(held > 0, 'no stick-slip');
});

test('wipers clear their arc and leave a ridge at its edge', () => {
  const sim = new GlassWater(PANES, 6);
  // Build up water, then wipe for a few strokes while it keeps raining.
  run(sim, 3, 20, 1, 0, false);
  run(sim, 4.05, 20, 1, 0, true, 3);
  const w = WIPERS[0];
  let inside = 0,
    ridge = 0,
    insideArea = 0,
    ridgeArea = 0;
  // Area of the swept annulus sector vs the thin band just outside it.
  const sector = 1.8;
  insideArea = (sector / 2) * ((w.r1 - 0.05) ** 2 - (w.r0 + 0.05) ** 2);
  ridgeArea = (sector / 2) * ((w.r1 + 0.02) ** 2 - w.r1 ** 2);
  for (const d of sim.drops) {
    if (d.pane !== 0) continue;
    const qu = d.u - w.pivot[0],
      qv = d.v - w.pivot[1];
    const r = Math.hypot(qu, qv);
    const th = Math.atan2(qv, -qu);
    if (th < 0.1 || th > 1.7) continue;
    const vol = d.r ** 3;
    if (r > w.r0 + 0.05 && r < w.r1 - 0.05) inside += vol;
    if (r > w.r1 && r < w.r1 + 0.02) ridge += vol;
  }
  assert.ok(
    ridge / ridgeArea > (inside / insideArea) * 3,
    `ridge ${(ridge / ridgeArea).toExponential(2)} vs swept ${(inside / insideArea).toExponential(2)}`,
  );
});

test('snow melts on the windshield but stays on the side windows', () => {
  const sim = new GlassWater(PANES, 7);
  run(sim, 12, 20, 0, 1, false);
  const wsSnow = sim.drops.filter(d => d.pane === 0 && d.snow).length;
  const wsWater = sim.drops.filter(d => d.pane === 0 && !d.snow).length;
  const sideSnow = sim.drops.filter(d => d.pane !== 0 && d.snow).length;
  assert.ok(wsWater > 0, 'melted drops on the windshield');
  // Per square metre of glass.
  const wsArea = 1.86 * 1.0,
    sideArea = 2 * 2.31 * 0.45;
  assert.ok(
    sideSnow / sideArea > wsSnow / wsArea,
    `side snow ${sideSnow} ws snow ${wsSnow}`,
  );
});
