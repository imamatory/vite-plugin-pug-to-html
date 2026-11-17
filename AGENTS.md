# vite-plugin-pug-to-html

A Vite plugin written in TypeScript (`src/`), published as compiled JavaScript from `dist/`.

## Checks

- `mise run check` runs every check (hk): lint, format, types, Knip, tests, package contents, spelling, Markdown, links, secrets and workflows. CI runs the same command. A change is done only when it passes.
- `pnpm run check` is the package part of it: build, typecheck, Oxlint, oxfmt, Knip, tests and `pnpm pack --dry-run`.
- `mise run fix` applies the safe autofixes. Review the diff.
- Tests import the built package from `dist/`, so `pnpm test` needs `pnpm run build` first. `pnpm run check` does both.

## Rules

- `dist/` is generated and ignored by git. Never edit it by hand.
- Do not disable a lint rule or add a suppression to get a change through. An exception is narrow (one path, one rule), carries a reason and needs a human decision.
- Commit messages follow Conventional Commits (commitlint checks them).
