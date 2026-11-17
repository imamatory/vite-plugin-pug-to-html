import { Worker } from 'worker_threads';

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
export function compileInWorkers({ files, workerCount, workerData }) {
  const workers = [];
  const results = new Array(files.length);
  let nextIndex = 0;
  let doneCount = 0;
  let settled = false;
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const finish = (error) => {
    if (settled) return;
    settled = true;
    Promise.allSettled(workers.map((worker) => worker.terminate())).then(() => {
      if (error) settle.reject(error);
      else settle.resolve(results);
    });
  };

  const dispatch = (worker) => {
    if (nextIndex >= files.length) return;
    const id = nextIndex;
    nextIndex += 1;
    worker.postMessage({ id, filePath: files[id] });
  };

  const onMessage = (worker, { id, html, dependencies, error }) => {
    if (settled) return;
    if (error) {
      // The message already names the file (see `render` in compiler.js).
      const failure = new Error(error.message);
      failure.stack = error.stack ?? failure.stack;
      finish(failure);
      return;
    }
    results[id] = { html, dependencies };
    doneCount += 1;
    if (doneCount === files.length) finish();
    else dispatch(worker);
  };

  const startWorker = () => {
    const worker = new Worker(WORKER_URL, { workerData });
    workers.push(worker);
    worker.on('message', (message) => onMessage(worker, message));
    // Thrown outside a page compile, e.g. the template params module failed to load.
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => finish(new Error(`pug-to-html: worker exited with code ${code} before finishing`)));
    dispatch(worker);
  };

  if (files.length === 0) finish();
  for (let i = 0; i < Math.min(workerCount, files.length); i += 1) startWorker();

  return { promise, cancel: () => finish(new CompileCancelledError()) };
}
