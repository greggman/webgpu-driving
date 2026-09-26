// Deferred, asynchronous pipeline creation. Modules register descriptors
// (with a callback that stores the result); compileDeferred() then creates
// them with createRenderPipelineAsync / createComputePipelineAsync a few at a
// time, reporting progress. Shader compilation is the slowest part of start-up
// on phones, so this both avoids blocking and lets the loading bar move.

type Job = {label: string; run: () => Promise<void>};
const jobs: Job[] = [];
let failHandler: ((msg: string) => void) | null = null;

export function setPipelineFailHandler(fn: (msg: string) => void) {
  failHandler = fn;
}

export function deferRenderPipeline(
  device: GPUDevice,
  desc: GPURenderPipelineDescriptor,
  assign: (p: GPURenderPipeline) => void,
) {
  jobs.push({
    label: desc.label ?? 'render pipeline',
    run: async () => assign(await device.createRenderPipelineAsync(desc)),
  });
}

export function deferComputePipeline(
  device: GPUDevice,
  desc: GPUComputePipelineDescriptor,
  assign: (p: GPUComputePipeline) => void,
) {
  jobs.push({
    label: desc.label ?? 'compute pipeline',
    run: async () => assign(await device.createComputePipelineAsync(desc)),
  });
}

export function pendingPipelines(): number {
  return jobs.length;
}

// Compiles everything registered so far; onProgress(done, total, label).
export async function compileDeferred(
  onProgress: (done: number, total: number, label: string) => void,
  concurrency = 3,
) {
  const list = jobs.splice(0);
  const total = list.length;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const job = list[next++];
      try {
        await job.run();
      } catch (e) {
        const msg = `pipeline "${job.label}": ${(e as Error).message}`;
        console.error(`[gpu-error] ${msg}`);
        failHandler?.(msg);
      }
      done++;
      onProgress(done, total, job.label);
    }
  };
  await Promise.all(Array.from({length: concurrency}, worker));
}
