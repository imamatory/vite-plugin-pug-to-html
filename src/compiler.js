// Pug page compiler shared by the dev path (main thread) and the build workers.
//
// It runs the same stages as `pug.compile` (lex → parse → load → filters → link → code-gen), with
// two differences that do not change the html:
//
// 1. The parsed AST of every file is memoised. `pug.compileFile` lexes and parses the layout and
//    every include again for each page; here a shared file is parsed once per compiler.
//    `pug-load` deep-clones the AST it is given, so a cached AST is never mutated.
// 2. Templates are generated with `compileDebug: false` (no line tracking code). When a template
//    throws, it is compiled again with debug code, so the error still names the pug file and line.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
// The stage packages are dependencies of `pug`, so resolve them from there: the versions always
// match the installed pug, and they are not reachable from here in a strict node_modules layout.
const pugRequire = createRequire(require.resolve('pug'));
const lex = pugRequire('pug-lexer');
const stripComments = pugRequire('pug-strip-comments');
const parse = pugRequire('pug-parser');
const load = pugRequire('pug-load');
const filters = pugRequire('pug-filters');
const link = pugRequire('pug-linker');
const generateCode = pugRequire('pug-code-gen');
const runtimeWrap = pugRequire('pug-runtime/wrap');

// Only options that survive `postMessage` to a worker. Function-valued pug options are not
// accepted: `filters` come from the `filtersModule` plugin option, `plugins` are not supported.
const PUG_OPTION_NAMES = ['basedir', 'doctype', 'filterAliases', 'filterOptions', 'globals', 'pretty', 'self'];

export function validatePugOptions(pugOptions) {
  const unknown = Object.keys(pugOptions).filter((name) => !PUG_OPTION_NAMES.includes(name));
  if (unknown.length > 0) {
    const hint = unknown.includes('filters') ? '; pass filters with the "filtersModule" option' : '';
    throw new Error(
      `pug-to-html: unsupported pugOptions: ${unknown.join(', ')} (supported: ${PUG_OPTION_NAMES.join(', ')})${hint}`,
    );
  }
}

/**
 * Resolve an object from a spec that can be sent to a worker: `{ value }` (a plain object) or
 * `{ path, exportName }` (a module to import). Used for template params and for filters.
 */
export async function loadModuleSpec(spec) {
  if (!spec.path) return spec.value;

  const mod = await import(pathToFileURL(spec.path).href);
  // For a CommonJS module `default` is `module.exports`; named exports are not always detected.
  const params = spec.exportName ? (mod[spec.exportName] ?? mod.default?.[spec.exportName]) : (mod.default ?? mod);
  if (!params || typeof params !== 'object') {
    const name = spec.exportName ? `export "${spec.exportName}"` : 'default export';
    throw new Error(`pug-to-html: ${name} of ${spec.path} must be an object, got ${typeof params}`);
  }
  return params;
}

export function createCompiler({ templateParams = {}, filters: customFilters = {}, pugOptions = {} } = {}) {
  validatePugOptions(pugOptions);

  // filename → { source, ast }. An entry is reused only while the file content is the same, so
  // edits in dev need no explicit invalidation.
  const astCache = new Map();

  const parseFile = (source, filename) => {
    const cached = astCache.get(filename);
    if (cached && cached.source === source) return cached.ast;

    const tokens = lex(source, { filename }).map((token) =>
      token.type === 'path' && path.extname(token.val) === '' ? { ...token, val: `${token.val}.pug` } : token,
    );
    const ast = parse(stripComments(tokens, { filename }), { filename, src: source });
    astCache.set(filename, { source, ast });
    return ast;
  };

  const compile = (filePath, compileDebug) => {
    const dependencies = [];
    const loaded = load.string(readFileSync(filePath, 'utf8'), {
      filename: filePath,
      basedir: pugOptions.basedir,
      // Lexing is deferred to `parse`, where the filename is known and the cache can be used.
      lex: (source) => source,
      parse: (source, options) => parseFile(source, options.filename),
      read: (filename) => {
        dependencies.push(filename);
        return readFileSync(filename);
      },
    });
    const ast = link(
      filters.handleFilters(loaded, customFilters, pugOptions.filterOptions, pugOptions.filterAliases),
    );
    const body = generateCode(ast, {
      compileDebug,
      pretty: pugOptions.pretty ?? false,
      doctype: pugOptions.doctype,
      globals: pugOptions.globals,
      self: pugOptions.self,
      inlineRuntimeFunctions: false,
      includeSources: false,
      templateName: 'template',
    });
    return { template: runtimeWrap(body), dependencies };
  };

  /** Compile one page. Returns `{ html, dependencies }`; `dependencies` lists included files. */
  const renderFast = (filePath) => {
    const compiled = compile(filePath, false);
    try {
      return { html: compiled.template(templateParams), dependencies: compiled.dependencies };
    } catch (error) {
      // A lex/parse error already carries the file and line. A template that failed while
      // rendering does not: repeat it with debug code, which throws the detailed error.
      compile(filePath, true).template(templateParams);
      throw error;
    }
  };

  const render = (filePath) => {
    try {
      return renderFast(filePath);
    } catch (error) {
      throw new Error(`pug-to-html: failed to compile ${filePath}\n${error?.message ?? error}`, { cause: error });
    }
  };

  return { render };
}
