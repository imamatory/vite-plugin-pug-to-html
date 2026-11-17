// Type-checked by `pnpm run typecheck`; never executed.
import type { Plugin, UserConfig } from 'vite';
import pugToHtmlPlugin from 'vite-plugin-pug-to-html';

const plugin: Plugin = pugToHtmlPlugin({
  input: { pages: '/abs/src/pages/*.pug', tags: ['/abs/src/tags/**/*.pug'] },
  dest: '/abs/dist',
  templateParamsModule: { path: '/abs/params.js', exportName: 'PARAMS' },
  filtersModule: '/abs/filters.js',
  pugOptions: {
    basedir: '/abs/src',
    pretty: false,
    filterAliases: { md: 'markdown' },
    filterOptions: { md: { html: true } },
  },
  workers: 'auto',
});

export const config: UserConfig = {
  plugins: [
    plugin,
    pugToHtmlPlugin({ input: { pages: 'x/*.pug' }, dest: 'dist', templateParams: { a: 1 }, workers: false }),
  ],
};

// @ts-expect-error `dest` is required
pugToHtmlPlugin({ input: {} });
// @ts-expect-error filters come from `filtersModule`
pugToHtmlPlugin({ input: {}, dest: 'dist', pugOptions: { filters: {} } });
// @ts-expect-error `workers` takes 'auto', a number or false
pugToHtmlPlugin({ input: {}, dest: 'dist', workers: true });
