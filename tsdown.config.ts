import { defineConfig } from 'tsdown'

/**
 * Host-half only.
 *
 * `src/client.tsx` is a React component, not a DSH client plugin: it exports no
 * `name`, no `inject` and no `apply`, so it registers nothing and cannot be
 * activated. A `client` entry here also emits an ESM file, while the host loads
 * a client bundle as a classic script wrapped in `window.__ModuleLoader__.load`
 * — so shipping it failed web boot outright:
 *
 *   Uncaught SyntaxError: Cannot use import statement outside a module
 *   web boot: 1 entry did not activate
 *
 * That failure is fatal for the whole app, and the component bought nothing, so
 * the client half is not declared or built until it is written as a real client
 * plugin (see `dsh.client` in package.json). The card component is kept in the
 * tree, still typechecked, ready to be wired up.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  outExtensions: () => ({ js: '.js' }),
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/schemastery',
      '@earendil-works/pi-ai',
      'react',
    ],
  },
})
