import {initGpu, WebGpuUnavailableError} from './gpu/gpu';

function showError(message: string) {
  const el = document.getElementById('error')!;
  el.textContent = message;
  el.style.display = 'flex';
}

async function main() {
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  const {device, context} = gpu;
  const frame = () => {
    const encoder = device.createCommandEncoder({label: 'frame'});
    const pass = encoder.beginRenderPass({
      label: 'clear',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView({label: 'swapchain'}),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.4, 0.6, 0.9, 1],
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as unknown as {__dev: object}).__dev = {ready: true, settled: true};
}

main().catch(e => {
  console.error(e);
  showError(
    e instanceof WebGpuUnavailableError ? e.message : `Error: ${String(e)}`,
  );
});
