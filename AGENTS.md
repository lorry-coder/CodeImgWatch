# Repository Guidelines

## Project Structure & Module Organization

ImView is a TypeScript VS Code extension. `src/extension.ts` is the extension entry point. Core debugger coordination and image operations live in `src/core/`; debugger-specific image decoders belong in `src/parsers/`; VS Code tree, webview, and editor integrations are in `src/providers/`; shared contracts and helpers are under `src/types/` and `src/utils/`. The browser-side viewer is maintained separately in `webview/`, with canvas logic in `webview/canvas/` and CSS in `webview/styles/`.

Tests are split between `test/unit/` and extension-host tests in `test/suite/`. Documentation is in `docs/`, icons and other packaged assets are in `resources/`, and `samples/test_opencv.cpp` supports manual debugger testing. Treat `out/`, `dist/`, and `*.vsix` files as generated artifacts.

## Build, Test, and Development Commands

- `npm ci` installs the lockfile-pinned dependencies.
- `npm run compile` bundles the extension and webview in development mode.
- `npm run watch` rebuilds bundles while files change; press `F5` in VS Code to launch the Extension Development Host.
- `npm run lint` checks TypeScript under `src/` with ESLint.
- `npm test` compiles tests and bundles, then runs Mocha in a downloaded VS Code test host.
- `npm run package` creates production bundles; use `npx vsce package --allow-missing-repository` to produce a VSIX.

## Coding Style & Naming Conventions

Keep TypeScript strict and use four-space indentation, single quotes, semicolons, and trailing commas in multiline constructs. Use `PascalCase` for classes, interfaces, and types; `camelCase` for functions, variables, and file names (for example, `debugSessionManager.ts`). Keep parser implementations focused on one image family and export public modules through the nearest `index.ts`. Run ESLint before submitting; do not hand-edit compiled output.

## Testing Guidelines

Tests use Mocha's BDD API and Node's `assert`. Name files `*.test.ts` and group cases with descriptive `describe`/`it` blocks. Add fast logic coverage under `test/unit/`; reserve `test/suite/` for VS Code activation, commands, and integration behavior. There is no enforced coverage threshold, but every bug fix should include a regression test. For debugger or rendering changes, also exercise the relevant C++ or Python sample manually.

## Commit & Pull Request Guidelines

History favors concise, imperative subjects, with Conventional Commit prefixes such as `feat:` for user-facing work. Keep each commit scoped and explain non-obvious debugger or data-format decisions in the body. Pull requests should summarize behavior, list verification commands, link relevant issues, and call out supported debuggers and image types affected. Include screenshots or a short recording for viewer/UI changes, and avoid committing generated bundles or VSIX packages.
