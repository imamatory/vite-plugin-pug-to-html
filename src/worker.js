// Worker thread entry: compiles the pages it is sent, one message per page.
import { parentPort, workerData } from 'worker_threads';
import { createCompiler, loadTemplateParams } from './compiler.js';

// Template params may hold functions, which cannot be posted: the worker imports them itself.
const templateParams = await loadTemplateParams(workerData.templateParams);
const compiler = createCompiler({ templateParams, pugOptions: workerData.pugOptions });

// Messages posted before this listener is attached are queued by the port.
parentPort.on('message', ({ id, filePath }) => {
  try {
    const { html, dependencies } = compiler.render(filePath);
    parentPort.postMessage({ id, html, dependencies });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: String(error?.message ?? error), stack: error?.stack } });
  }
});
