import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.tsx',
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