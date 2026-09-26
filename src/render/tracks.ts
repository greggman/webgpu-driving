// Tyre tracks on dirt roads (see tracks.wgsl): every car leaves two ribbons
// along its recent path (sampled in road coordinates, so they stay put when
// the car changes lanes), fading with age.
import {shaderModule} from '../gpu/gpu';
import {deferRenderPipeline} from '../gpu/pipelines';
import {Road} from '../world/road';
import {RENDER_PRELUDE} from './shaders';
import trackSrc from '../shaders/tracks.wgsl';
import {
  DEPTH_FORMAT,
  HDR_FORMAT,
  NORMAL_FORMAT,
  VELOCITY_FORMAT,
} from './targets';

export interface TrackSource {
  id: number;
  s: number; // arc length of the car's rear axle
  d: number; // lateral offset
    track: number; // wheel track (m)
  dir: number; // +1 when driving toward increasing s
}

const STEP = 1.5; // m between path samples
const KEEP = 70; // samples per car (~100 m)
const MAX_VERTS = 64 * 2 * KEEP * 6;
const V_FLOATS = 6;

export class TireTracks {
  private pipe!: GPURenderPipeline;
  private vbuf: GPUBuffer;
  private data = new Float32Array(MAX_VERTS * V_FLOATS);
  private count = 0;
  private paths = new Map<number, Array<{s: number; d: number}>>();
  enabled = false;

  constructor(
    private device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
  ) {
    const d = device;
    this.vbuf = d.createBuffer({
      label: 'tire-tracks-vertices',
      size: this.data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const module = shaderModule(
      d,
      RENDER_PRELUDE + '\n' + trackSrc,
      'tire-tracks',
    );
    const blend: GPUBlendState = {
      color: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
    };
    deferRenderPipeline(
      d,
      {
        label: 'tire-tracks',
        layout: d.createPipelineLayout({
          label: 'tire-tracks-pl',
          bindGroupLayouts: [frameLayout],
        }),
        vertex: {
          module,
          entryPoint: 'vs',
          buffers: [
            {
              arrayStride: V_FLOATS * 4,
              attributes: [
                {shaderLocation: 0, offset: 0, format: 'float32x3'},
                {shaderLocation: 1, offset: 12, format: 'float32x3'},
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {format: HDR_FORMAT, blend},
            {format: VELOCITY_FORMAT, writeMask: 0},
            {format: NORMAL_FORMAT, writeMask: 0},
          ],
        },
        primitive: {topology: 'triangle-list'},
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: false,
          depthCompare: 'greater',
        },
      },
      p => (this.pipe = p),
    );
  }

  reset() {
    this.paths.clear();
    this.count = 0;
  }

  // loc converts world to the render's floating-origin coordinates.
  update(road: Road, cars: TrackSource[], loc: (p: number[]) => number[]) {
    if (!this.enabled) return;
    const seen = new Set<number>();
    for (const c of cars) {
      seen.add(c.id);
      let path = this.paths.get(c.id);
            if (!path) {
        // A car we haven't seen yet already drove here along its lane.
        path = [];
        for (let k = KEEP - 1; k >= 1; --k)
          path.push({s: c.s - c.dir * k * STEP, d: c.d});
        this.paths.set(c.id, path);
      }
      const last = path[path.length - 1];
      if (!last || Math.abs(c.s - last.s) >= STEP) {
        path.push({s: c.s, d: c.d});
        if (path.length > KEEP) path.shift();
      }
    }
    for (const id of [...this.paths.keys()])
      if (!seen.has(id)) this.paths.delete(id);
    // Ribbons.
    const out = this.data;
    let n = 0;
    const W = 0.26;
    for (const c of cars) {
      const path = this.paths.get(c.id)!;
      // Include the car's current position as the newest point.
      const pts = [...path, {s: c.s, d: c.d}];
      if (pts.length < 2) continue;
      for (const side of [-0.5, 0.5]) {
        for (let i = 0; i + 1 < pts.length; ++i) {
          if (n + 6 > MAX_VERTS) break;
          const a = pts[i],
            b = pts[i + 1];
          const age0 = (pts.length - 1 - i) / pts.length,
            age1 = (pts.length - 2 - i) / pts.length;
          const q = (p: {s: number; d: number}, off: number) => {
            const r = road.pointAt(p.s, p.d + side * c.track + off);
            const l = loc(r.pos);
            return [l[0], l[1] + 0.02, l[2]];
          };
          const a0 = q(a, -W / 2),
            a1 = q(a, W / 2),
            b0 = q(b, -W / 2),
            b1 = q(b, W / 2);
          const sa = 1 - age0,
            sb = 1 - age1;
          // Tread pattern coordinate: absolute arc length (stays put).
          const va = a.s % 1000,
            vb = va + (b.s - a.s);
          const vtx: Array<[number[], number, number, number]> = [
            [a0, 0, va, sa],
            [a1, 1, va, sa],
            [b0, 0, vb, sb],
            [b0, 0, vb, sb],
            [a1, 1, va, sa],
            [b1, 1, vb, sb],
          ];
          for (const [p, u, v, s] of vtx) {
            out.set([p[0], p[1], p[2], u, v, s], n * V_FLOATS);
            n++;
          }
        }
      }
    }
    this.count = n;
    if (n) this.device.queue.writeBuffer(this.vbuf, 0, out, 0, n * V_FLOATS);
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.enabled || !this.count || !this.pipe) return;
    pass.setPipeline(this.pipe);
    pass.setVertexBuffer(0, this.vbuf);
    pass.draw(this.count);
  }
}
