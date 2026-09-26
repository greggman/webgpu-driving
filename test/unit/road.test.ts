import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Road, ROAD_DZ} from '../../src/world/road';
import {BIOMES, BIOME_ORDER} from '../../src/world/biome';
import {noised, hash2i} from '../../src/math/noise';

test('noise is deterministic and bounded', () => {
  assert.equal(hash2i(3, -7), hash2i(3, -7));
  for (let i = 0; i < 1000; ++i) {
    const [v] = noised(i * 0.37 - 100, i * 0.91 + 33);
    assert.ok(Math.abs(v) < 1, `noise out of range ${v}`);
  }
});

for (const id of BIOME_ORDER) {
  test(`road invariants: ${id}`, () => {
    const road = new Road(BIOMES[id], 1);
    const zEnd = 20000;
    road.ensure(zEnd + 10);
    let prevS = -1;
    let maxGrade = 0;
    let prev = road.atZ(0);
    for (let z = ROAD_DZ; z < zEnd; z += ROAD_DZ) {
      const p = road.atZ(z);
      assert.ok(p.s > prevS, 'arc length must increase');
      prevS = p.s;
      assert.ok(Math.abs(p.heading) <= BIOMES[id].road.maxHeading + 1e-6);
      const ds = p.s - prev.s;
      maxGrade = Math.max(maxGrade, Math.abs(p.y - prev.y) / ds);
      prev = p;
    }
    assert.ok(maxGrade < 0.16, `grade too steep: ${maxGrade}`);
    // Nearest-point query recovers lateral offsets.
    for (const s of [500, 3000, 9000]) {
      for (const d of [-20, -3, 0, 5, 40]) {
        const {pos} = road.pointAt(s, d);
        const info = road.info(pos[0], pos[2]);
        assert.ok(Math.abs(info.d - d) < 0.5, `d ${info.d} vs ${d}`);
      }
    }
  });
}

test('road is deterministic per seed', () => {
  const a = new Road(BIOMES.country, 7).atZ(5000);
  const b = new Road(BIOMES.country, 7).atZ(5000);
  const c = new Road(BIOMES.country, 8).atZ(5000);
  assert.deepEqual(a, b);
  assert.notEqual(a.x, c.x);
});
