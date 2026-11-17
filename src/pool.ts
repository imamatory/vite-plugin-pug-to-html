import { Worker } from 'worker_threads';
import type { RenderResult } from './compiler.js';
import type { WorkerData, WorkerMessage } from './worker-protocol.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export class CompileCancelledError extends Error {
  constructor() {
    super('pug-to-html: compilation was cancelled');
    this.name = 'CompileCancelledError';
  }
}

/**
 * Compile `files` in `workerCount` worker threads.
 *
 * Workers pull the next file when they finish one, so slow pages do not unbalance the pool.
 * Returns `{ promise, cancel }`. `promise` resolves to `[{ html, dependencies }]` in the order of
 * `files`. It rejects on the first failed page, on a crashed worker or on `cancel()`. All
 * workers are terminated before the promise settles in any way, so nothing keeps the process alive.
 */
export function compileInWorkers({
  files,
  workerCount,
  workerData,
}: {
  files: string[];
  workerCount: number;
  workerData: WorkerData;
}): { promise: Promise<RenderResult[]>; cancel: () => void } {
  const workers: Worker[] = [];
  const results: RenderResult[] = [];
  let nextIndex = 0;
  let doneCount = 0;
  let settled = false;
  let settle!: { resolve: (value: RenderResult[]) => void; reject: (error: unknown) => void };
  const promise = new Promise<RenderResult[]>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    Promise.allSettled(workers.map((worker) => worker.terminate())).then(() => {
      if (error) settle.reject(error);
      else settle.resolve(results);
    });
  };

  const dispatch = (worker: Worker) => {
    if (nextIndex >= files.length) return;
    const id = nextIndex;
    nextIndex += 1;
    worker.postMessage({ id, filePath: files[id] });
  };

  const onMessage = (worker: Worker, message: WorkerMessage) => {
    if (settled) return;
    if ('error' in message) {
      const { error } = message;
      // The message already names the file (see `render` in compiler.js).
      const failure = new Error(error.message);
      failure.stack = error.stack ?? failure.stack;
      finish(failure);
      return;
    }
    results[message.id] = { html: message.html, dependencies: message.dependencies };
    doneCount += 1;
    if (doneCount === files.length) finish();
    else dispatch(worker);
  };

  const startWorker = () => {
    const worker = new Worker(WORKER_URL, { workerData });
    workers.push(worker);
    worker.on('message', (message: WorkerMessage) => onMessage(worker, message));
    // Thrown outside a page compile, e.g. the template params module failed to load.
    worker.on('error', (error: Error) => finish(error));
    worker.on('exit', (code: number) =>
      finish(new Error(`pug-to-html: worker exited with code ${code} before finishing`)),
    );
    dispatch(worker);
  };

  if (files.length === 0) finish();
  for (let i = 0; i < Math.min(workerCount, files.length); i += 1) startWorker();

  return { promise, cancel: () => finish(new CompileCancelledError()) };
}
