// Vite plugin: compiles standalone pug pages to html files in `dest`.
//
// Options:
// - `input`: `{ [subfolder]: glob }`. Every matched file becomes `<dest>/<subfolder>/<name>.html`.
// - `dest`: output directory.
// - `templateParams`: object passed to every template.
// - `templateParamsModule`: absolute path of a module that exports the params, or
//   `{ path, exportName }`. Use it instead of `templateParams` when the params hold functions:
//   functions cannot be sent to worker threads, so each worker imports the module itself.
// - `pugOptions`: `basedir`, `doctype`, `globals`, `pretty` (default `false`), `self`.
// - `workers`: `'auto'` (default), a number of worker threads, or `false` to compile on the main
//   thread.
// - `cacheDir`: directory of the dev cache. Default: Vite's `cacheDir`.
//
// Build: pages are compiled in worker threads from `buildStart`, while the bundler works, and are
// written in `closeBundle`. They cannot be written earlier: `vite:prepare-out-dir` empties
// `outDir` in `renderStart`, after `buildStart`.
// Dev: pages are compiled on the main thread, and only when a page or its includes changed.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { createCompiler, loadTemplateParams, validatePugOptions } from './compiler.js';
import { CompileCancelledError, compileInWorkers } from './pool.js';

const require = createRequire(import.meta.url);
const { globSync } = require('fast-glob');
const pc = require('picocolors');

// Used until `configResolved` provides Vite's logger, e.g. when the hooks are called directly.
const consoleLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const PUG_CACHE_VERSION = 1;
const PUG_CACHE_FILE = 'pug-cache.json';
// Measured on 305 pages: 4 workers are 2.5x faster than the main thread, more are not faster.
// Every worker parses the shared includes itself, so extra workers mostly repeat that work.
const MAX_AUTO_WORKERS = 4;
// A worker costs about 100 ms to start; do not start one for a handful of pages.
const MIN_PAGES_PER_WORKER = 8;

const isCloneable = (value) => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

const resolveTemplateParamsSpec = (templateParams, templateParamsModule) => {
  if (templateParamsModule === undefined) {
    if (templateParams !== undefined && (templateParams === null || typeof templateParams !== 'object')) {
      throw new Error(`pug-to-html: "templateParams" must be an object, got ${typeof templateParams}`);
    }
    return { value: templateParams ?? {} };
  }
  if (templateParams !== undefined) {
    throw new Error('pug-to-html: pass either "templateParams" or "templateParamsModule", not both');
  }

  const spec = typeof templateParamsModule === 'string' ? { path: templateParamsModule } : templateParamsModule;
  if (!spec || typeof spec.path !== 'string' || !path.isAbsolute(spec.path)) {
    throw new Error('pug-to-html: "templateParamsModule" must be an absolute path or { path, exportName }');
  }
  return { path: spec.path, exportName: spec.exportName };
};

export default function pugToHtmlPlugin({
  input,
  dest,
  templateParams,
  templateParamsModule,
  pugOptions = {},
  workers = 'auto',
  cacheDir,
} = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error(`pug-to-html: "input" must be an object, got ${typeof input}`);
  }
  if (!dest) {
    throw new Error('pug-to-html: "dest" is required');
  }
  if (workers !== 'auto' && workers !== false && !(Number.isInteger(workers) && workers >= 0)) {
    throw new Error(`pug-to-html: "workers" must be 'auto', false or a non-negative integer, got ${workers}`);
  }
  validatePugOptions(pugOptions);
  const templateParamsSpec = resolveTemplateParamsSpec(templateParams, templateParamsModule);
  const canUseWorkers = Boolean(templateParamsSpec.path) || isCloneable(templateParamsSpec.value);

  const destRoot = path.resolve(dest);
  const globResults = {};
  const writtenFiles = [];
  // html paths written by two pages, already reported: warn once, not on every dev recompile.
  const reportedCollisions = new Set();
  let isBuild = false;
  let viteCacheDir;
  let logger = consoleLogger;
  let buildJob = null;
  let compilerPromise;

  const getCachePath = () =>
    path.resolve(cacheDir ?? viteCacheDir ?? path.resolve('node_modules/.vite'), PUG_CACHE_FILE);

  const getCompiler = () => {
    compilerPromise ??= loadTemplateParams(templateParamsSpec).then((params) =>
      createCompiler({ templateParams: params, pugOptions }),
    );
    return compilerPromise;
  };

  const formatSize = (bytes) => {
    const kb = bytes / 1024;
    if (kb >= 1024) {
      return `${(kb / 1024).toFixed(2)} MB`;
    }
    if (kb >= 1) {
      return `${kb.toFixed(2)} kB`;
    }
    return `${bytes} B`;
  };

  const colorBySize = (str, bytes) => {
    if (bytes < 10240) return pc.green(str);
    if (bytes < 102400) return pc.yellow(str);
    return pc.red(str);
  };

  const logBuildOutput = (summary) => {
    if (writtenFiles.length === 0) return;

    const maxLen = Math.max(...writtenFiles.map((f) => path.basename(f).length));
    const pad = maxLen + 4;

    logger.info('');
    writtenFiles.forEach((outPath) => {
      if (!existsSync(outPath)) return;
      const { size } = statSync(outPath);
      const sizeStr = formatSize(size);
      const dir = pc.dim(`${path.dirname(outPath)}/`);
      const name = path.basename(outPath);
      logger.info(
        `${dir}${colorBySize(name, size)}${' '.repeat(pad - name.length)}${pc.bold(colorBySize(sizeStr, size))}`,
      );
    });
    logger.info(`  ${pc.dim(`${writtenFiles.length} files, ${summary}`)}`);
  };

  const loadCache = () => {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) {
      return { version: PUG_CACHE_VERSION, files: {} };
    }

    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cache.version !== PUG_CACHE_VERSION || !cache.files) {
        return { version: PUG_CACHE_VERSION, files: {} };
      }
      return cache;
    } catch {
      return { version: PUG_CACHE_VERSION, files: {} };
    }
  };

  const getMtimeMs = (file) => (existsSync(file) ? statSync(file).mtimeMs : null);

  const isCacheFresh = (htmlPath, cacheEntry) => {
    if (!cacheEntry || cacheEntry.output !== htmlPath || !existsSync(htmlPath)) {
      return false;
    }

    const dependencies = cacheEntry.dependencies ?? [];
    if (dependencies.length === 0) {
      return false;
    }

    return dependencies.every((dependency) => {
      const mtimeMs = getMtimeMs(dependency);
      return mtimeMs !== null && mtimeMs === cacheEntry.mtimes[dependency];
    });
  };

  const writeCache = (cache) => {
    const cachePath = getCachePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  };

  const collectPages = () => {
    const pages = [];
    const owners = new Map();

    Object.entries(input).forEach(([subfolder, pattern]) => {
      const files = globSync(pattern);
      globResults[subfolder] = files;

      files.forEach((filePath) => {
        const htmlPath = path.resolve(destRoot, subfolder, `${path.basename(filePath, '.pug')}.html`);
        if (!htmlPath.startsWith(destRoot + path.sep)) {
          throw new Error(`pug-to-html: output of ${filePath} is outside "dest": ${htmlPath}`);
        }
        const owner = owners.get(htmlPath);
        if (owner !== undefined && owner !== filePath && !reportedCollisions.has(htmlPath)) {
          reportedCollisions.add(htmlPath);
          logger.warn(pc.yellow(`pug-to-html: ${owner} and ${filePath} both write ${htmlPath}; the last one wins`));
        }
        owners.set(htmlPath, filePath);
        pages.push({ filePath, htmlPath });
      });
    });

    return pages;
  };

  const writePage = ({ filePath, htmlPath }, { html, dependencies }, cache) => {
    mkdirSync(path.dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html);
    writtenFiles.push(htmlPath);

    const allDependencies = [...new Set([filePath, ...dependencies])];
    const mtimes = {};
    allDependencies.forEach((dependency) => {
      mtimes[dependency] = getMtimeMs(dependency);
    });

    cache.files[filePath] = { output: htmlPath, dependencies: allDependencies, mtimes };
  };

  // Dev: compile on the main thread the pages whose html is missing or older than its sources.
  const compileStale = async () => {
    const compiler = await getCompiler();
    const cache = loadCache();
    writtenFiles.length = 0;

    try {
      collectPages().forEach((page) => {
        if (isCacheFresh(page.htmlPath, cache.files[page.filePath])) return;
        writePage(page, compiler.render(page.filePath), cache);
      });
    } finally {
      if (writtenFiles.length > 0) writeCache(cache);
    }
  };

  const resolveWorkerCount = (pageCount) => {
    if (workers === false || !canUseWorkers) return 0;
    const limit = workers === 'auto' ? Math.min(os.availableParallelism(), MAX_AUTO_WORKERS) : workers;
    return Math.min(limit, Math.floor(pageCount / MIN_PAGES_PER_WORKER));
  };

  // Build: every page is compiled, the dev cache is not consulted. `outDir` is emptied during the
  // build, and a production build must not depend on file mtimes.
  const startBuildJob = () => {
    const startedAt = performance.now();
    const pages = collectPages();
    const workerCount = resolveWorkerCount(pages.length);

    if (workerCount === 0) {
      // Compiled in `closeBundle`: compiling here would block the bundler's JS hooks.
      return { pages, workerCount, startedAt, promise: null, cancel: () => {} };
    }

    const { promise, cancel } = compileInWorkers({
      files: pages.map((page) => page.filePath),
      workerCount,
      workerData: { templateParams: templateParamsSpec, pugOptions },
    });
    const job = { pages, workerCount, startedAt, promise, cancel, compiledAt: null };
    promise.then(
      () => {
        job.compiledAt = performance.now();
      },
      // The rejection is reported from `closeBundle`; do not let it become an unhandled rejection.
      () => {},
    );

    return job;
  };

  const finishBuildJob = async (job) => {
    const waitStartedAt = performance.now();
    let results;
    if (job.promise) {
      results = await job.promise;
    } else {
      const compiler = await getCompiler();
      results = job.pages.map((page) => compiler.render(page.filePath));
    }

    const cache = loadCache();
    writtenFiles.length = 0;
    job.pages.forEach((page, index) => writePage(page, results[index], cache));
    // Lets the next dev start skip the pages this build has just written.
    if (writtenFiles.length > 0) writeCache(cache);

    const seconds = (from, to = performance.now()) => `${((to - from) / 1000).toFixed(2)}s`;
    logBuildOutput(
      job.promise
        ? `${seconds(job.startedAt, job.compiledAt)} in ${job.workerCount} workers, ${seconds(waitStartedAt)} after the bundle`
        : seconds(waitStartedAt),
    );
  };

  const collectWatchedDirs = () => {
    const dirs = new Set();

    Object.values(globResults).forEach((files) => {
      files.forEach((f) => dirs.add(path.dirname(f)));
    });

    const cache = loadCache();
    Object.values(cache.files).forEach((entry) => {
      (entry.dependencies ?? []).forEach((dep) => {
        dirs.add(path.dirname(dep));
      });
    });

    return dirs;
  };

  const refreshOnPugChange = async (server, file) => {
    if (!file.endsWith('.pug')) return;
    try {
      await compileStale();
      server.ws.send({ type: 'full-reload' });
    } catch (error) {
      // A broken template must not take the dev server down: report it and wait for the fix.
      server.config.logger.error(pc.red(error.message), { error });
      server.ws.send({ type: 'error', err: { message: error.message, stack: error.stack ?? '' } });
    }
  };

  return {
    name: 'pug-to-html',
    configResolved(config) {
      isBuild = config.command === 'build';
      viteCacheDir = config.cacheDir;
      logger = config.logger ?? consoleLogger;
    },
    buildStart() {
      if (!isBuild) return;
      // `vite build --watch` starts a new build while the previous one may still be compiling.
      buildJob?.cancel();
      buildJob = startBuildJob();
    },
    buildEnd(error) {
      if (error) buildJob?.cancel();
    },
    async closeBundle() {
      if (!isBuild) return;
      const job = buildJob ?? startBuildJob();
      buildJob = null;

      try {
        await finishBuildJob(job);
      } catch (error) {
        // Cancelled because the bundle failed: that error is the one to report.
        if (!(error instanceof CompileCancelledError)) throw error;
      }
    },
    async configureServer(server) {
      await compileStale();

      collectWatchedDirs().forEach((dir) => server.watcher.add(dir));

      server.watcher.on('add', (file) => refreshOnPugChange(server, file));
      server.watcher.on('change', (file) => refreshOnPugChange(server, file));
      server.watcher.on('unlink', (file) => refreshOnPugChange(server, file));
    },
  };
}
