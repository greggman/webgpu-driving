import {initGpu, WebGpuUnavailableError} from './gpu/gpu';
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

async function main() {
  const dev: DevHooks = {ready: false, settled: false};
  (window as unknown as {__dev: DevHooks}).__dev = dev;
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  const app = new App(gpu, parseParams());
  dev.app = app;
  dev.ready = true;
  dev.stats = () => ({
    frames: app.frames,
    biome: app.biome.id,
    ...app.renderer.stats,
    ...app.debugInfo(),
  });
  const loop = (t: number) => {
    app.frame(t);
    if (!dev.settled && app.settled) {
      // Wait for the GPU to finish before reporting.
      void gpu.device.queue.onSubmittedWorkDone().then(() => {
        dev.settled = true;
      });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch(e => {
  console.error(e);
  showError(
    e instanceof WebGpuUnavailableError ? e.message : `Error: ${String(e)}`,
  );
});
