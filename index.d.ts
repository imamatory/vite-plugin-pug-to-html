import type { Plugin } from 'vite';

/** Pug compiler options the plugin accepts. Function-valued options (`filters`, `plugins`) are not supported. */
export interface PugToHtmlPugOptions {
  /** Root for absolute `include` and `extends` paths. */
  basedir?: string;
  doctype?: string;
  globals?: string[];
  /** Indent the html. Default: `false`. */
  pretty?: boolean | string;
  self?: boolean;
}

export interface PugToHtmlTemplateParamsModule {
  /** Absolute path of an ESM or CommonJS module. */
  path: string;
  /** Named export that holds the params. Default: the default export (`module.exports`). */
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
  templateParamsModule?: string | PugToHtmlTemplateParamsModule;
  pugOptions?: PugToHtmlPugOptions;
  /** Worker threads used in a build: `'auto'` (default), a number, or `false` for the main thread. */
  workers?: 'auto' | number | false;
  /** Directory of the dev cache file `pug-cache.json`. Default: Vite's `cacheDir`. */
  cacheDir?: string;
}

export default function pugToHtmlPlugin(options: PugToHtmlOptions): Plugin;
