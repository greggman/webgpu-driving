// WebGPU device bootstrap and small resource helpers.

export class WebGpuUnavailableError extends Error {}

// Called for device loss and for the first occurrence of each uncaptured
// WebGPU error, so the page can show the problem instead of a black screen.
let problemHandler: ((msg: string, fatal: boolean) => void) | null = null;
export function setGpuProblemHandler(
  fn: (msg: string, fatal: boolean) => void,
) {
  problemHandler = fn;
}

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  format: GPUTextureFormat;
  hasTimestamps: boolean;
  hasFloat32Filterable: boolean;
  lost: boolean;
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) {
    throw new WebGpuUnavailableError(
      'This page requires WebGPU, which this browser does not support (or has disabled).',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new WebGpuUnavailableError(
      'This page requires WebGPU, but no WebGPU adapter is available on this device.',
    );
  }

  const wanted: GPUFeatureName[] = ['timestamp-query', 'float32-filterable'];
  const requiredFeatures = wanted.filter(f => adapter.features.has(f));
  const lim = adapter.limits;
  const device = await adapter.requestDevice({
    label: 'driving-device',
    requiredFeatures,
    requiredLimits: {
      maxStorageBuffersPerShaderStage: Math.min(
        10,
        lim.maxStorageBuffersPerShaderStage,
      ),
      maxStorageTexturesPerShaderStage: Math.min(
        8,
        lim.maxStorageTexturesPerShaderStage,
      ),
      maxTextureArrayLayers: lim.maxTextureArrayLayers,
      maxBufferSize: lim.maxBufferSize,
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: lim.maxComputeWorkgroupStorageSize,
      maxColorAttachmentBytesPerSample: Math.min(
        64,
        lim.maxColorAttachmentBytesPerSample,
      ),
    },
  });
  const result = {lost: false};
  void device.lost.then(info => {
    result.lost = true;
    console.error(`[gpu-error] device lost: ${info.reason} ${info.message}`);
    problemHandler?.(
      `The GPU device was lost (${info.reason || 'unknown'}): ${info.message}`,
      true,
    );
  });
  // Every uncaptured validation / OOM / internal error is printed with a
  // greppable prefix; the puppeteer harness fails the run when it sees one.
  // Repeats of the same message (e.g. every frame) are counted, not
  // re-printed, so the first (root-cause) error stays visible.
  const seen = new Map<string, number>();
  device.addEventListener('uncapturederror', e => {
    const err = (e as GPUUncapturedErrorEvent).error;
    const msg = `${err.constructor.name}: ${err.message}`;
    const n = (seen.get(msg) ?? 0) + 1;
    seen.set(msg, n);
    if (n === 1) problemHandler?.(msg, false);
    if (n === 1 || n === 100 || n === 10000) {
      console.error(`[gpu-error]${n > 1 ? ` (x${n})` : ''} ${msg}`);
    }
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({device, format, alphaMode: 'opaque'});

  return Object.assign(result, {
    adapter,
    device,
    context,
    canvas,
    format,
    hasTimestamps: device.features.has('timestamp-query'),
    hasFloat32Filterable: device.features.has('float32-filterable'),
  });
}

export function createBuffer(
  device: GPUDevice,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags,
  label: string,
): GPUBuffer {
  const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
  const buffer = device.createBuffer({
    label,
    size,
    usage: usage | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  buffer.unmap();
  return buffer;
}

// Shader module cache keyed by source; logs compilation errors in a way the
// test harness detects.
const moduleCache = new Map<string, GPUShaderModule>();

export function shaderModule(
  device: GPUDevice,
  code: string,
  label: string,
): GPUShaderModule {
  let m = moduleCache.get(code);
  if (!m) {
    m = device.createShaderModule({code, label});
    moduleCache.set(code, m);
    void m.getCompilationInfo().then(info => {
      for (const msg of info.messages) {
        if (msg.type === 'error') {
          const lines = code.split('\n');
          console.error(
            `[gpu-error] ${label}:${msg.lineNum}:${msg.linePos} ${msg.message}\n  ${lines[msg.lineNum - 1] ?? ''}`,
          );
        }
      }
    });
  }
  return m;
}
