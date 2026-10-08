import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import dts from 'rollup-plugin-dts';

const external = ['nostr-tools'];

export default [
  // ESM build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.esm.js',
      format: 'es',
      sourcemap: true
    },
    plugins: [
      resolve(),
      commonjs(),
      typescript({ tsconfig: './tsconfig.json' })
    ],
    external
  },
  // CommonJS build
  {
    input: 'src/index.ts',
    output: {
      // `.cjs`, not `.js`: package.json has "type": "module", so Node would
      // load a `.js` file as ESM and require() would fail (ERR_REQUIRE_ESM).
      file: 'dist/index.cjs',
      format: 'cjs',
      sourcemap: true
    },
    plugins: [
      resolve(),
      commonjs(),
      typescript({ tsconfig: './tsconfig.json' })
    ],
    external
  },
  // UMD build for browsers
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.umd.js',
      format: 'umd',
      name: 'NostrChunkedEvents',
      sourcemap: true,
      globals: {
        'nostr-tools': 'NostrTools'
      }
    },
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.json' })
    ],
    external
  },
  // Type declarations: `.d.ts` for import, `.d.cts` for require
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.d.ts', format: 'es' },
      { file: 'dist/index.d.cts', format: 'es' }
    ],
    plugins: [dts()],
    external
  }
];
