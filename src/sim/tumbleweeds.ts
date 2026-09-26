// Tumbleweeds rolling across the desert road with the wind (CPU, a handful).
import {Rng} from '../math/noise';
import {Road} from '../world/road';

interface Weed {
  s: number;
  d: number;
  vd: number; // lateral speed (m/s)
  roll: number;
  phase: number;
  scale: number;
}

export class Tumbleweeds {
  private weeds: Weed[] = [];
  private rng: Rng;

  constructor(
    private road: Road,
    seed: number,
    private count: number,
  ) {
    this.rng = new Rng(seed * 17 + 5);
  }

  private spawn(sPlayer: number, initial: boolean): Weed {
    const dir = this.rng.next() < 0.8 ? 1 : -1;
    return {
      s: sPlayer + this.rng.range(initial ? 20 : 120, 260),
      d: -dir * this.rng.range(initial ? 0 : 25, 45),
      vd: dir * this.rng.range(2.5, 5.5),
      roll: 0,
      phase: this.rng.range(0, 6),
      scale: this.rng.range(0.8, 1.6),
    };
  }

  update(dt: number, sPlayer: number, time: number) {
    while (this.weeds.length < this.count) {
      this.weeds.push(this.spawn(sPlayer, this.weeds.length < this.count / 2));
    }
    for (let i = 0; i < this.weeds.length; ++i) {
      const w = this.weeds[i];
      w.d += w.vd * dt;
      w.roll += (Math.abs(w.vd) * dt) / (0.4 * w.scale);
      if (Math.abs(w.d) > 50 || w.s < sPlayer - 40)
        this.weeds[i] = this.spawn(sPlayer, false);
    }
    void time;
  }

  instances(time: number) {
    return this.weeds.map(w => {
      const p = this.road.pointAt(w.s, w.d);
      const g = this.road.groundHeight(p.pos[0], p.pos[2]);
      const bounce = Math.abs(Math.sin(time * 2.2 + w.phase)) * 0.5 * w.scale;
      return {
        kind: 'tumbleweed' as const,
        x: p.pos[0],
        y: g + 0.38 * w.scale + bounce,
        z: p.pos[2],
        // Roll axis perpendicular to the travel direction (across the road).
        yaw: p.heading,
        stretch: w.scale,
        scale: w.scale,
        tint: 0.5,
        roll: w.roll * Math.sign(w.vd),
      };
    });
  }
}
