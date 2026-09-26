import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Traffic, MIN_GAP} from '../../src/sim/traffic';
import {BIOMES} from '../../src/world/biome';

for (const id of ['country', 'night', 'lahonda'] as const) {
  test(`traffic never overlaps: ${id}`, () => {
    const t = new Traffic(BIOMES[id], 3, 500);
    let worst = Infinity;
    let lane = 0;
    for (let i = 0; i < 60 * 240; ++i) {
      t.update(1 / 60);
      // Random player input.
      if (i % 700 === 0) t.requestLane(lane++ % 2 ? 1 : -1);
      if (i % 1300 === 0) t.adjustSpeed(i % 2600 ? 6 : -6);
      worst = Math.min(worst, t.minGap());
    }
    assert.ok(worst >= MIN_GAP - 0.01, `min gap ${worst}`);
    assert.ok(t.player.s > 500 + 240 * 5, `player advanced ${t.player.s}`);
  });
}

for (const id of ['country', 'night'] as const) {
  test(`autopilot lane changes are decisive: ${id}`, () => {
    const t = new Traffic(BIOMES[id], 5, 500);
    const minutes = 5;
    let offCentre = 0;
    let lastFlips = 0;
    let lastFlipTime = -1e9;
    let minGapBetweenFlips = Infinity;
    for (let i = 0; i < 60 * 60 * minutes; ++i) {
      t.update(1 / 60);
      if (t.laneFlips !== lastFlips) {
        minGapBetweenFlips = Math.min(minGapBetweenFlips, t.time - lastFlipTime);
        lastFlipTime = t.time;
        lastFlips = t.laneFlips;
      }
      // Time spent straddling lanes while not changing lanes.
      if (Math.abs(t.player.d - t.player.dTarget) > 1.2 && t.time - lastFlipTime > 4) {
        offCentre += 1 / 60;
      }
    }
    assert.ok(minGapBetweenFlips >= 1.9, `flip-flopping: ${minGapBetweenFlips}s between lane changes`);
    assert.ok(t.laneFlips < minutes * 12, `too many lane changes: ${t.laneFlips}`);
    assert.ok(offCentre < 1, `straddled lanes for ${offCentre.toFixed(1)}s`);
  });
}
