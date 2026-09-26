import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Road} from '../../src/world/road';
import {BIOMES, BIOME_ORDER} from '../../src/world/biome';
import {Director} from '../../src/camera/director';
import {Pose} from '../../src/sim/pose';

// Line of sight over the terrain + road deck heightfield.
function clear(road: Road, a: number[], b: number[]): boolean {
  for (let k = 1; k < 40; ++k) {
    const t = k / 40;
    const x = a[0] + (b[0] - a[0]) * t,
      y = a[1] + (b[1] - a[1]) * t,
      z = a[2] + (b[2] - a[2]) * t;
    if (road.groundHeight(x, z) > y + 0.05) return false;
  }
  return true;
}

for (const id of BIOME_ORDER) {
  test(`roadside cameras see the car: ${id}`, () => {
    const road = new Road(BIOMES[id], 7);
    const dir = new Director(road, 7, {});
    let blocked = 0,
      shots = 0;
    for (let i = 0; i < 60; ++i) {
      const sCar = 300 + i * 170;
      dir.cut(sCar, 'roadside');
      const p = road.pointAt(sCar, 0);
      const pose: Pose = {
        pos: p.pos,
        fwd: [Math.sin(p.heading), 0, Math.cos(p.heading)],
        left: [Math.cos(p.heading), 0, -Math.sin(p.heading)],
        up: [0, 1, 0],
        speed: 20,
      } as Pose;
      const cam = dir.update(0, pose, sCar, 4.8);
      if (cam.shot !== 'roadside') continue; // no good spot: another shot
      shots++;
      // At the anchor's closest approach the car must be in view.
      const st = (dir as unknown as {shot: {anchorS: number}}).shot;
      const q = road.pointAt(st.anchorS, 0).pos;
      if (!clear(road, cam.eye, [q[0], q[1] + 1, q[2]])) blocked++;
      assert.ok(
        road.groundHeight(cam.eye[0], cam.eye[2]) < cam.eye[1],
        'camera below ground / under a deck',
      );
    }
    assert.ok(shots > 20, `too few roadside shots (${shots})`);
    assert.equal(blocked, 0, `${blocked}/${shots} roadside shots blocked`);
  });
}
