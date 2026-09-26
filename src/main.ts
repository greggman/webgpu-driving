import {initGpu, setGpuProblemHandler, WebGpuUnavailableError} from './gpu/gpu';
import {LOW_POWER_GRAPHICS} from './render/renderer';
import {saveGraphics} from './ui/settings';
import {App, parseParams} from './app';

function showError(message: string) {
  const el = document.getElementById('error')!;
  el.textContent = message;
  el.style.display = 'flex';
}

interface DevHooks {
  ready: boolean;
  settled: boolean;
  app?: App;
  stats?: () => object;
}

// Loading status shown from the moment the page opens (before the App
// exists), with an elapsed-time counter.
const loadStart = performance.now();
function status(label: string, frac: number) {
  document.getElementById('loading-label')!.textContent = label;
  document.getElementById('loading-bar')!.style.width =
    `${Math.round(frac * 100)}%`;
}
const timer = setInterval(() => {
  const el = document.getElementById('loading')!;
  const t = document.getElementById('loading-time')!;
  t.textContent = el.classList.contains('visible')
    ? `${Math.round((performance.now() - loadStart) / 1000)} s`
    : '';
}, 250);
void timer;

function paint(): Promise<void> {
  return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
}

function showGpuProblem(msg: string, fatal: boolean) {
  const box = document.getElementById('gpu-problem')!;
  if (box.classList.contains('visible') && !fatal) return;
  document.getElementById('gpu-problem-msg')!.textContent =
    (fatal ? 'Rendering stopped. ' : 'A WebGPU error occurred: ') +
    msg +
    (fatal
      ? ' This can happen on phones when a frame takes too long for the GPU.'
      : '');
  box.classList.add('visible');
}

async function main() {
  const dev: DevHooks = {ready: false, settled: false};
  (window as unknown as {__dev: DevHooks}).__dev = dev;
  setGpuProblemHandler(showGpuProblem);
  document.getElementById('gpu-dismiss')!.addEventListener('click', () => {
    document.getElementById('gpu-problem')!.classList.remove('visible');
  });
  document.getElementById('gpu-reload-low')!.addEventListener('click', () => {
    saveGraphics({...LOW_POWER_GRAPHICS});
    location.reload();
  });
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  status('Starting WebGPU…', 0.01);
  await paint();
  const gpu = await initGpu(canvas);
  status('Creating shaders and pipelines…', 0.03);
  await paint();
  const app = new App(gpu, parseParams());
  await paint();
  await app.generate(app.params.biome);
  dev.app = app;
  dev.ready = true;
  dev.stats = () => ({
    frames: app.frames,
    biome: app.biome.id,
    ...app.renderer.stats,
    gpu: Object.fromEntries(
      Object.entries(app.renderer.profiler.ms).map(([k, v]) => [
        k,
        Math.round(v * 100) / 100,
      ]),
    ),
    ...app.debugInfo(),
  });
  const loop = (t: number) => {
    // Stop rendering once the device is gone (the banner explains why).
    if (gpu.lost) return;
    app.frame(t);
    if (!dev.settled && app.settled) {
      // Wait for the GPU to finish before reporting.
      void gpu.device.queue.onSubmittedWorkDone().then(() => {
        dev.settled = true;
      });
    }
    if (app.showingProgress) {
      // While warming up (shader compilation on first use can take many
      // seconds on phones) don't queue more frames than the GPU has done;
      // the page stays responsive and the progress UI keeps animating.
      void gpu.device.queue
        .onSubmittedWorkDone()
        .then(() => requestAnimationFrame(loop));
    } else {
      requestAnimationFrame(loop);
    }
  };
  requestAnimationFrame(loop);
}

main().catch(e => {
  console.error(e);
  document.getElementById('loading')!.classList.remove('visible');
  showError(
    e instanceof WebGpuUnavailableError ? e.message : `Error: ${String(e)}`,
  );
});
