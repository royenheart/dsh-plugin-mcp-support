import type { UserConfig } from 'tsdown'

const PACKAGE = '@royenheart/dsh-plugin-mcp-support'

/** Host-side externals: harness packages (resolved from the dsh node_modules at runtime). */
function hostExternal(id: string): boolean {
  return id.startsWith('@deepseek-ai/') || id.startsWith('@cordisjs/')
}

/**
 * Module-table externals the browser require answers (the web platform seed
 * list). `@deepseek-ai/dsh-client-ui-renderer` and
 * `@deepseek-ai/dsh-client-ui-conversation` are type-only in this bundle and
 * are erased, so they are intentionally absent here: a value import would be
 * inlined (duplicate identity) and must instead become an explicit
 * `dsh.client.external` request.
 */
const BROWSER_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    // dts works against the 0.1.2-alpha.3 dependency set, where every
    // harness package resolves to the same schemastery copy.
    dts: true,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: hostExternal },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: true,
    clean: false,
    deps: { neverBundle: BROWSER_EXTERNALS },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
