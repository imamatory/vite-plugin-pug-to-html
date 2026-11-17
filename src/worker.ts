// Worker thread entry: compiles the pages it is sent, one message per page.
import { parentPort, workerData } from 'worker_threads';
import { createCompiler, loadModuleSpec } from './compiler.js';
import type { WorkerData, WorkerMessage, WorkerRequest } from './worker-protocol.js';

const data = workerData as WorkerData;
const port = parentPort;
if (!port) throw new Error('pug-to-html: worker.js must run in a worker thread');

// Template params and filters may hold functions, which cannot be posted: the worker imports them.
const [templateParams, filters] = await Promise.all([
  loadModuleSpec(data.templateParams),
  loadModuleSpec(data.filters),
]);
const compiler = createCompiler({ templateParams, filters, pugOptions: data.pugOptions });

const send = (message: WorkerMessage) => port.postMessage(message);

// Messages posted before this listener is attached are queued by the port.
port.on('message', ({ id, filePath }: WorkerRequest) => {
  try {
    const { html, dependencies } = compiler.render(filePath);
    send({ id, html, dependencies });
  } catch (error) {
    send({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
});
