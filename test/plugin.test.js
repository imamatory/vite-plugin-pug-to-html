// Run: npm test
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import pugToHtmlPlugin from '../src/index.js';

const pug = createRequire(import.meta.url)('pug');

let root;
let src;
let dest;

const write = (name, content) => {
  const file = path.join(src, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const writePages = (count) => {
  write('layout.pug', 'html\n  body\n    include partials/header\n    block content\n');
  write('partials/header.pug', 'header(class=["a", "b"]) #{title || "none"}\n');
  for (let i = 0; i < count; i += 1) {
    write(`pages/page${i}.pug`, `extends ../layout\nblock content\n  p(data-n=${i}) page ${i} #{shout("x")}\n`);
  }
};

const writeParamsModule = () => {
  const file = path.join(root, 'params.cjs');
  writeFileSync(file, 'module.exports = { PARAMS: { shout: (s) => s.toUpperCase() } };\n');
  return { path: file, exportName: 'PARAMS' };
};

const createPlugin = (options = {}) => {
  const plugin = pugToHtmlPlugin({
    input: { pages: path.join(src, 'pages/*.pug') },
    dest,
    cacheDir: path.join(root, 'cache'),
    templateParamsModule: writeParamsModule(),
    ...options,
  });
  plugin.configResolved({ command: 'build', cacheDir: path.join(root, 'cache') });
  return plugin;
};

// The hooks in the order Vite calls them; `vite:prepare-out-dir` empties `dest` in between.
const runBuild = async (plugin) => {
  plugin.buildStart();
  rmSync(dest, { recursive: true, force: true });
  plugin.buildEnd();
  await plugin.closeBundle();
};

const silenceConsole = (t) => {
  t.mock.method(console, 'log', () => {});
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pug-to-html-'));
  src = path.join(root, 'src');
  dest = path.join(root, 'dist');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

[false, 2].forEach((workers) => {
  test(`build output equals pug.compileFile (workers: ${workers})`, async (t) => {
    silenceConsole(t);
    writePages(20);

    await runBuild(createPlugin({ workers }));

    for (let i = 0; i < 20; i += 1) {
      const expected = pug.compileFile(path.join(src, `pages/page${i}.pug`))({ shout: (s) => s.toUpperCase() });
      assert.equal(readFileSync(path.join(dest, `pages/page${i}.html`), 'utf8'), expected);
    }
  });

  test(`a syntax error fails the build and names the file (workers: ${workers})`, async (t) => {
    silenceConsole(t);
    writePages(20);
    const broken = write('pages/broken.pug', 'p(class="unclosed"\n');

    await assert.rejects(runBuild(createPlugin({ workers })), (error) => {
      assert.match(error.message, /pug-to-html: failed to compile/);
      assert.ok(error.message.includes(broken));
      return true;
    });
  });

  test(`a render error names the pug file and line (workers: ${workers})`, async (t) => {
    silenceConsole(t);
    writePages(20);
    const broken = write('pages/broken.pug', 'p ok\np= missing.property\n');

    await assert.rejects(runBuild(createPlugin({ workers })), (error) => {
      assert.ok(error.message.includes(`${broken}:2`), error.message);
      assert.match(error.message, /missing/);
      return true;
    });
  });
});

test('an error in an included file names the page and the include', async (t) => {
  silenceConsole(t);
  writePages(20);
  write('partials/header.pug', 'header(\n');

  await assert.rejects(runBuild(createPlugin({ workers: 2 })), (error) => {
    assert.match(error.message, /pages\/page\d+\.pug/);
    assert.ok(error.message.includes(path.join(src, 'partials/header.pug')));
    return true;
  });
});

test('a failed bundle cancels the compilation and writes nothing', async (t) => {
  silenceConsole(t);
  writePages(20);
  const plugin = createPlugin({ workers: 2 });

  plugin.buildStart();
  plugin.buildEnd(new Error('bundle failed'));
  await plugin.closeBundle();

  assert.equal(existsSync(dest), false);
});

test('a failing template params module fails the build', async (t) => {
  silenceConsole(t);
  writePages(20);
  const plugin = createPlugin({ workers: 2, templateParamsModule: path.join(root, 'missing.cjs') });

  await assert.rejects(runBuild(plugin), /missing\.cjs/);
});

test('template params with functions are compiled on the main thread', async (t) => {
  silenceConsole(t);
  writePages(20);
  const plugin = createPlugin({
    workers: 2,
    templateParamsModule: undefined,
    templateParams: { shout: (s) => `${s}!` },
  });

  await runBuild(plugin);

  assert.match(readFileSync(path.join(dest, 'pages/page0.html'), 'utf8'), /page 0 x!/);
});

test('rejects invalid options', () => {
  const base = { input: { pages: 'x/*.pug' }, dest: '/tmp/x' };
  assert.throws(() => pugToHtmlPlugin({ dest: '/tmp/x' }), /"input"/);
  assert.throws(() => pugToHtmlPlugin({ input: {} }), /"dest"/);
  assert.throws(() => pugToHtmlPlugin({ ...base, workers: -1 }), /"workers"/);
  assert.throws(() => pugToHtmlPlugin({ ...base, pugOptions: { filters: {} } }), /unsupported pugOptions: filters/);
  assert.throws(() => pugToHtmlPlugin({ ...base, templateParamsModule: 'relative.js' }), /absolute path/);
  assert.throws(() => pugToHtmlPlugin({ ...base, templateParams: {}, templateParamsModule: '/abs.js' }), /not both/);
});

test('an input key cannot write outside dest', async (t) => {
  silenceConsole(t);
  writePages(1);
  const plugin = createPlugin({ input: { '../outside': path.join(src, 'pages/*.pug') } });

  assert.throws(() => plugin.buildStart(), /outside "dest"/);
});

test('dev compiles only the pages whose sources changed', async () => {
  writePages(3);
  const plugin = createPlugin();
  plugin.configResolved({ command: 'serve', cacheDir: path.join(root, 'cache') });
  const handlers = {};
  const sent = [];
  const server = {
    watcher: { add: () => {}, on: (event, handler) => Object.assign(handlers, { [event]: handler }) },
    ws: { send: (message) => sent.push(message) },
    config: { logger: { error: () => {} } },
  };

  await plugin.configureServer(server);
  const page0 = path.join(dest, 'pages/page0.html');
  const page1 = path.join(dest, 'pages/page1.html');
  assert.match(readFileSync(page0, 'utf8'), /page 0 X/);

  // Mark both outputs, then touch the source of one page: only that page is rewritten.
  writeFileSync(page0, 'stale');
  writeFileSync(page1, 'stale');
  const source = write('pages/page1.pug', 'p changed\n');
  await handlers.change(source);
  assert.equal(readFileSync(page0, 'utf8'), 'stale');
  assert.equal(readFileSync(page1, 'utf8'), '<p>changed</p>');
  assert.deepEqual(sent, [{ type: 'full-reload' }]);

  // A broken template is reported to the client and does not throw.
  write('pages/page1.pug', 'p(\n');
  await handlers.change(source);
  assert.equal(sent[1].type, 'error');
  assert.ok(sent[1].err.message.includes(source));
});

test('two pages that write the same html file are reported once', async (t) => {
  silenceConsole(t);
  writePages(1);
  write('other/page0.pug', 'p other\n');
  const warnings = [];
  const plugin = createPlugin({
    workers: false,
    input: { pages: [path.join(src, 'pages/*.pug'), path.join(src, 'other/*.pug')] },
  });
  plugin.configResolved({
    command: 'build',
    cacheDir: path.join(root, 'cache'),
    logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
  });

  await runBuild(plugin);
  await runBuild(plugin);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /both write .*page0\.html/);
});
