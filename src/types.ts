/**
 * Pug compiler options the plugin accepts. Function-valued options are not: pass `filters` with the
 * `filtersModule` plugin option; `plugins` are not supported.
 */
export interface PugToHtmlPugOptions {
  /** Root for absolute `include` and `extends` paths. */
  basedir?: string;
  doctype?: string;
  /** Other names for filters, e.g. `{ md: 'markdown' }`. Aliases cannot point to other aliases. */
  filterAliases?: Record<string, string>;
  /** Default options of each filter, keyed by the name written in the template (the alias, if used). */
  filterOptions?: Record<string, Record<string, unknown>>;
  globals?: string[];
  /** Indent the html. Default: `false`. */
  pretty?: boolean | string;
  self?: boolean;
}

export interface PugToHtmlModule {
  /** Absolute path of an ESM or CommonJS module. */
  path: string;
  /** Named export to use. Default: the default export (`module.exports`). */
  exportName?: string;
}

export interface PugToHtmlOptions {
  /**
   * Pages to compile, grouped by output subfolder: `{ [subfolder]: glob }` (fast-glob patterns).
   * Every matched file becomes `<dest>/<subfolder>/<basename>.html`.
   */
  input: Record<string, string | string[]>;
  /** Output directory. */
  dest: string;
  /** Locals passed to every template. Mutually exclusive with `templateParamsModule`. */
  templateParams?: Record<string, unknown>;
  /**
   * Absolute path of a module that exports the locals, or `{ path, exportName }`. Use it when the
   * locals hold functions: every worker thread imports the module itself.
   */
  templateParamsModule?: string | PugToHtmlModule;
  /**
   * Absolute path of a module that exports pug filters (`{ [name]: (text, options) => string }`), or
   * `{ path, exportName }`. Every worker thread imports the module itself.
   */
  filtersModule?: string | PugToHtmlModule;
  pugOptions?: PugToHtmlPugOptions;
  /** Worker threads used in a build: `'auto'` (default), a number, or `false` for the main thread. */
  workers?: 'auto' | number | false;
  /** Directory of the dev cache file `pug-cache.json`. Default: Vite's `cacheDir`. */
  cacheDir?: string;
}
