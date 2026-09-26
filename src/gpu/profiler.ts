// GPU pass timing with timestamp queries (when the adapter supports them).
// Each instrumented pass gets begin/end timestamps; results are read back
// asynchronously and smoothed.

const MAX = 64;

export class Profiler {
  private qs: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private readBufs: GPUBuffer[] = [];
  private labels: string[] = [];
  private pending = new Map<GPUBuffer, string[]>();
  readonly ms: Record<string, number> = {};

  constructor(
    private device: GPUDevice,
    enabled: boolean,
  ) {
    if (!enabled) return;
    this.qs = device.createQuerySet({
      label: 'gpu-timestamps',
      type: 'timestamp',
      count: MAX * 2,
    });
    this.resolveBuf = device.createBuffer({
      label: 'gpu-timestamps-resolve',
      size: MAX * 2 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  beginFrame() {
    this.labels = [];
  }

  // timestampWrites for a pass, or undefined when unsupported/full.
  pass(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.qs || this.labels.length >= MAX) return undefined;
    const i = this.labels.length;
    this.labels.push(label);
    return {
      querySet: this.qs,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1,
    };
  }

  endFrame(enc: GPUCommandEncoder) {
    if (!this.qs || !this.labels.length) return;
    const n = this.labels.length * 2;
    enc.resolveQuerySet(this.qs, 0, n, this.resolveBuf!, 0);
    let rb = this.readBufs.find(
      b => b.mapState === 'unmapped' && !this.pending.has(b),
    );
    if (!rb) {
      if (this.readBufs.length >= 3) return;
      rb = this.device.createBuffer({
        label: 'gpu-timestamps-read',
        size: MAX * 2 * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.readBufs.push(rb);
    }
    enc.copyBufferToBuffer(this.resolveBuf!, 0, rb, 0, n * 8);
    this.pending.set(rb, [...this.labels]);
  }

  afterSubmit() {
    for (const [buf, labels] of this.pending) {
      if (buf.mapState !== 'unmapped') continue;
      void buf.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(
          buf.getMappedRange().slice(0, labels.length * 16),
        );
        const sums: Record<string, number> = {};
        let total = 0;
        let lo = t[0],
          hi = t[1];
        labels.forEach((l, i) => {
          if (t[i * 2] < lo) lo = t[i * 2];
          if (t[i * 2 + 1] > hi) hi = t[i * 2 + 1];
          const d = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
          if (d >= 0 && d < 1000) {
            sums[l] = (sums[l] ?? 0) + d;
            total += d;
          }
        });
        sums.total = total;
        // Wall-clock GPU span of the frame (passes can overlap on TBDR GPUs,
        // so the per-pass sum overestimates).
        sums.span = Number(hi - lo) / 1e6;
        for (const [k, v] of Object.entries(sums)) {
          this.ms[k] =
            this.ms[k] === undefined ? v : this.ms[k] * 0.9 + v * 0.1;
        }
        buf.unmap();
        this.pending.delete(buf);
      });
    }
  }
}

// Global profiler used by passes throughout the renderer.
let current: Profiler | null = null;
export function setProfiler(p: Profiler | null) {
  current = p;
}
export function ts(label: string): GPURenderPassTimestampWrites | undefined {
  return current?.pass(label);
}
