# vite-plugin-pug-to-html

A Vite plugin that compiles standalone [Pug](https://pugjs.org) pages into static html files. Use it when the html
is not an entry point of the bundle: the files are written next to the bundle and consumed by something else, for
example a backend (Django, Rails, Laravel) that loads them as templates.

- Pages are compiled in worker threads **while the bundler works**, so they add almost nothing to `vite build`.
- Each layout and include is parsed once, not once per page: about 3x faster than `pug.compileFile` on one thread.
- In dev only pages whose sources changed are compiled, and the browser reloads.
- Errors name the page, the pug file and line, with a code frame. A broken page does not stop the dev server.

## Install

```sh
npm install --save-dev vite-plugin-pug-to-html pug
```

Requires Node 20.19+ or 22.12+, Vite 5 or newer and pug 3.

## Usage

```js
// vite.config.js
import path from 'node:path';
import pugToHtml from 'vite-plugin-pug-to-html';

export default {
  plugins: [
    pugToHtml({
      input: {
        pages: path.resolve('src/pages/*.pug'),
        tags: path.resolve('src/tags/**/*.pug'),
      },
      dest: path.resolve('dist/templates'),
      templateParamsModule: { path: path.resolve('template-params.js'), exportName: 'PARAMS' },
    }),
  ],
};
```

Every file matched by `input[subfolder]` becomes `<dest>/<subfolder>/<basename>.html`. Files that are only included
or extended by pages (layouts, partials, mixins) must not match the globs.

## Options

| Option                 | Type                               | Default           | Description                                                     |
| ---------------------- | ---------------------------------- | ----------------- | --------------------------------------------------------------- |
| `input`                | `{ [subfolder]: glob \| glob[] }`  | required          | Pages to compile, grouped by output subfolder (fast-glob)       |
| `dest`                 | `string`                           | required          | Output directory                                                |
| `templateParams`       | `object`                           | `{}`              | Locals passed to every template                                 |
| `templateParamsModule` | `string` or `{ path, exportName }` | none              | Absolute path of a module that exports the locals               |
| `pugOptions`           | `object`                           | `{}`              | `basedir`, `doctype`, `globals`, `pretty` (default `false`), `self` |
| `workers`              | `'auto'`, `number` or `false`      | `'auto'`          | Worker threads used in a build                                  |
| `cacheDir`             | `string`                           | Vite's `cacheDir` | Directory of the dev cache file `pug-cache.json`                |

Invalid options throw when the plugin is created, not during the build.

### Template params

Pass either `templateParams` or `templateParamsModule`, not both.

- `templateParamsModule` is the form to use when the params hold functions (helpers such as `merge` or
  `pluralize`). Functions cannot be sent to a worker thread, so every worker imports the module itself. The module
  can be ESM or CommonJS. Without `exportName` the default export (`module.exports`) is used.
- `templateParams` works in workers only if the object can be structured-cloned. If it holds functions, the
  plugin compiles on the main thread instead.
- The module is imported once per process and once per worker. Importing it must be cheap and free of side
  effects.

### Pug options

Only `basedir`, `doctype`, `globals`, `pretty` and `self` are accepted. Any other key throws. Function-valued pug
options (`filters`, `plugins`) are not supported: they cannot be sent to workers, and the plugin does not call
`pug.compile` (see [How pages are compiled](#how-pages-are-compiled)).

### Workers

- `'auto'`: `min(os.availableParallelism(), 4)` workers, and at most one worker per 8 pages. With fewer than 8
  pages no worker is started.
- A number: that many workers, with the same one-per-8-pages limit.
- `false` or `0`: compile on the main thread, in `closeBundle`.

`os.availableParallelism()` respects cgroup CPU limits on Linux, so a container limited to one CPU gets one worker.

## Build

1. `buildStart` collects the pages and starts the workers. It returns in a few milliseconds.
2. The bundler works. Rolldown bundles in native threads, the workers compile pug in parallel.
3. `closeBundle` waits for the workers, writes the html files and logs them with their sizes.

Details:

- The files are written in `closeBundle` and not earlier, because `vite:prepare-out-dir` empties `outDir` in
  `renderStart`, which runs after `buildStart`.
- A build always compiles every page. The dev cache is not read: `outDir` is emptied anyway, and a production
  build must not depend on file mtimes.
- The build still writes the dev cache, so a dev server started after a build skips the pages it has just written.
- Workers pull the next page when they finish one, so slow pages do not unbalance the pool.
- If the bundle fails, the compilation is cancelled, nothing is written and the bundle error is the one reported.
- `vite build --watch`: a new build cancels the compilation of the previous one.
- The last log line reads `305 files, 3.85s in 4 workers, 0.05s after the bundle`: the time the workers took, and
  the time `closeBundle` spent waiting for them and writing files. Only the second number is on the critical path.
- Output goes through Vite's logger, so `logLevel: 'warn'` or `--logLevel silent` hides the file list.

## Dev

- `configureServer` compiles on the main thread, before the server starts.
- Only stale pages are compiled. A page is fresh when its html exists in `dest` and the mtime of the page and of
  every file it includes or extends equals the mtime recorded in `<cacheDir>/pug-cache.json`.
- The directories of all pages and of their dependencies are watched. Any added, changed or removed `.pug` file
  triggers a compile of the stale pages and a full page reload.
- A broken template does not stop the dev server. The error is logged and shown in the Vite error overlay. The
  next successful compile reloads the page.
- A template that is broken when the dev server starts fails the start.

## How pages are compiled

The plugin does not call `pug.compileFile`. It runs the same stages (`pug-lexer`, `pug-strip-comments`,
`pug-parser`, `pug-load`, `pug-filters`, `pug-linker`, `pug-code-gen`, `pug-runtime`) with two changes. Neither
changes the html.

1. **Each file is parsed once.** `pug.compileFile` lexes and parses the layout and every include again for every
   page. The compiler keeps the parsed AST of each file, keyed by path and checked against the file content, so an
   edited file is parsed again without explicit invalidation. `pug-load` deep-clones the AST it receives, so a
   cached AST is never mutated.
2. **Templates are generated without debug code.** `compileDebug: true` (the pug default) adds line tracking to the
   generated function, which makes code generation slower. When a template throws while rendering, the plugin
   compiles it again with debug code and reports that error.

The stage packages are resolved from your installed `pug`, so their versions always match it. A test compares the
output with `pug.compileFile` to catch a pug release that changes the pipeline.

## Errors

A failed page fails the build with the page path, the pug file and line, and a code frame:

```text
pug-to-html: failed to compile /abs/src/pages/broken.pug
/abs/src/pages/broken.pug:2
    1| p ok
  > 2| p= missing.property
    3|

Cannot read properties of undefined (reading 'property')
```

- An error inside an included file names both the page and the included file.
- The first error stops the build; the other pages are not reported.
- All workers are terminated on an error, on cancellation and when a worker crashes, so the process does not hang.
- A template params module that fails to import fails the build.

## Safety

- An `input` key that would place a file outside `dest` (for example `../x`) throws.
- Two pages with the same basename in one subfolder write the same html file. The last one wins and a warning is
  logged once. `**` globs flatten the directory structure, so keep basenames unique.
- Templates run as code with full access to Node, in the build process. Compile trusted templates only.

## Performance

Measured on a real project: 305 pages compiled from 530 `.pug` files, Apple Silicon with 10 cores, Node 22,
pug 3.0.4, Vite 8. "Before" is a plugin that called `pug.compileFile` for every page in `closeBundle`.

| What                                     | Before | After  |
| ---------------------------------------- | ------ | ------ |
| Full `vite build`                        | 16.6 s | 5.6 s  |
| Pug on the critical path (`closeBundle`) | 12.6 s | 0.05 s |
| Pug alone, main thread                   | 11.3 s | 3.6 s  |
| Dev server cold start (no cache)         | 11 s   | 3.8 s  |
| Dev rebuild when nothing is stale        |        | 17 ms  |

Pug alone, by number of workers (nothing else running):

| Workers | 0     | 1     | 2     | 3     | 4     | 6     | 8     | 10    |
| ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| Time    | 3.6 s | 3.8 s | 2.2 s | 1.7 s | 1.5 s | 1.5 s | 1.6 s | 1.8 s |

- Each worker has its own AST cache and parses the shared includes itself. This is why more than 4 workers do not
  help and why `'auto'` stops at 4.
- During a real build the workers compete with the bundler for CPU and take about 4 s instead of 1.5 s. This does
  not matter while it stays below the bundling time.
- On a machine with one CPU the gain comes from the two compiler changes only (about 3x). Parsing each file once
  and dropping debug code each give about 35% on their own.

## Limitations

- Removing a page in dev does not remove its html from `dest`.
- There is no persistent build cache. It would only pay off when the cache directory survives between CI runs.
- Templates that call `Math.random()` produce different html on every build. The plugin does not seed it.

## Development

```sh
npm install
npm run check   # types, tests, package contents
```

The tests use `node:test` and temporary fixture directories, and call the hooks in the order Vite does.

## License

[MIT](LICENSE)
