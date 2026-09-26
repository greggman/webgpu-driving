import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Road} from '../../src/world/road';
import {BIOMES} from '../../src/world/biome';
import {Traffic} from '../../src/sim/traffic';
import {vehiclePose, Pose} from '../../src/sim/pose';
import {Director} from '../../src/camera/director';

// Drive the player for `secs` and record body heave / pitch and the
// interior camera's eye height relative to the (unbounced) car.
function drive(biome: 'desert' | 'country', secs: number) {
  const road = new Road(BIOMES[biome], 3);
  const t = new Traffic(BIOMES[biome], 3, 500);
  const p = t.player;
  const dir = new Director(road, 3, {});
  dir.forced = 'interior';
  dir.cut(p.s, 'interior');
  const chase = new Director(road, 3, {});
  chase.forced = 'chase';
  chase.cut(p.s, 'chase');
  const dt = 1 / 60;
  const heave: number[] = [],
    pitch: number[] = [],
    eyeRel: number[] = [],
    chaseRel: number[] = [];
  for (let i = 0; i < secs * 60; ++i) {
    t.update(dt);
    const pose: Pose = vehiclePose(road, p, dt, 2.85, 1.6);
    const cam = dir.update(dt, pose, p.s, 2.4);
    const cc = chase.update(dt, pose, p.s, 2.4);
    heave.push(pose.heave);
    pitch.push(pose.bumpPitch);
    eyeRel.push(cam.eye[1] - pose.pos[1]);
    chaseRel.push(cc.eye[1] - pose.pos[1]);
  }
  return {heave, pitch, eyeRel, chaseRel};
}

const range = (a: number[]) => Math.max(...a) - Math.min(...a);
const sd = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

test('the car bounces on dirt roads, not on paved ones', () => {
  const d = drive('desert', 10);
  const c = drive('country', 10);
  assert.ok(sd(d.heave) > 0.004, `desert heave sd ${sd(d.heave)}`);
  // Noticeable but gentle: a few cm, about a degree at most.
  assert.ok(range(d.heave) < 0.1, `heave range ${range(d.heave)}`);
  assert.ok(
    Math.max(...d.pitch.map(Math.abs)) < 0.03,
    `pitch ${Math.max(...d.pitch.map(Math.abs))}`,
  );
  assert.equal(range(c.heave), 0);
});

test('seated camera follows the bounce late and softer', () => {
  const d = drive('desert', 10);
  const skip = 60;
  const eye = d.eyeRel.slice(skip);
  const body = d.heave.slice(skip);
  // Softer than the body.
  assert.ok(sd(eye) < sd(body) * 0.9, `eye sd ${sd(eye)} body ${sd(body)}`);
  assert.ok(sd(eye) > sd(body) * 0.2, 'the head should still move');
  // Late: the best-matching lag is > 0.
  let best = 0,
    bestC = -Infinity;
  for (let lag = 0; lag < 30; ++lag) {
    let c = 0;
    for (let i = 30; i < eye.length; ++i) c += eye[i] * body[i - lag];
    if (c > bestC) {
      bestC = c;
      best = lag;
    }
  }
  assert.ok(best >= 3, `head lag ${best} frames`);
});

test('outside cameras ignore the bounce', () => {
  const road = new Road(BIOMES.desert, 3);
  const t = new Traffic(BIOMES.desert, 3, 500);
  const p = t.player;
  const a = new Director(road, 3, {}),
    b = new Director(road, 3, {});
  for (const d of [a, b]) {
    d.forced = 'chase';
    d.cut(p.s, 'chase');
  }
  let maxDiff = 0,
    maxHeave = 0;
  for (let i = 0; i < 300; ++i) {
    t.update(1 / 60);
    const pose = vehiclePose(road, p, 1 / 60, 2.85, 1.6);
    // The same pose with the suspension bounce taken out.
    const flat: Pose = {
      ...pose,
      heave: 0,
      bumpPitch: 0,
      bumpRoll: 0,
      fwd: pose.baseFwd,
      left: pose.baseLeft,
      up: [0, 1, 0],
    };
    const ea = a.update(1 / 60, pose, p.s, 2.4).eye;
    const eb = b.update(1 / 60, flat, p.s, 2.4).eye;
    maxDiff = Math.max(maxDiff, Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]));
    maxHeave = Math.max(maxHeave, Math.abs(pose.heave));
  }
  assert.ok(maxHeave > 0.005, 'the body should be bouncing');
  assert.ok(maxDiff < 1e-6, `chase eye moved ${maxDiff} m with the bounce`);
});
