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
