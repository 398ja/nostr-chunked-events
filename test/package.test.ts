/**
 * Packaging regression test (#2): `require()` of the published tarball failed
 * with ERR_REQUIRE_ESM in 0.3.0, because the CommonJS build was a `.js` file
 * under `"type": "module"`.
 *
 * Packs the library, installs the tarball into a temporary project and loads it
 * through every entry point a consumer uses: CommonJS `require()`, ESM `import`,
 * TypeScript types for both, and the UMD file in a plain script context.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ntVersion = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'nostr-tools', 'package.json'), 'utf8'),
).version;
const EXPECTED = ['ChunkedFetcher', 'ChunkedPublisher', 'createSnapshotChunks', 'SourceUnreachableError'];

let dir: string;

function run(cmd: string, args: string[], cwd = dir): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`);
  }
}

describe('packed tarball', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nce-pack-'));
    // `npm pack` runs `prepare`, so the tarball holds a fresh build.
    const out = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dir], ROOT));
    const tarball = join(dir, out[0].filename);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
    run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', tarball,
      `nostr-tools@${ntVersion}`, `typescript@${pkg.devDependencies.typescript}`]);
  }, 240_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('works with CommonJS require()', () => {
    writeFileSync(join(dir, 'req.cjs'),
      `const m = require('nostr-chunked-events');\nconsole.log(JSON.stringify(Object.keys(m)));\n`);
    const keys: string[] = JSON.parse(run('node', ['req.cjs']));
    expect(keys).toEqual(expect.arrayContaining(EXPECTED));
  });

  it('works with ESM import', () => {
    writeFileSync(join(dir, 'imp.mjs'),
      `import * as m from 'nostr-chunked-events';\nconsole.log(JSON.stringify(Object.keys(m)));\n`);
    const keys: string[] = JSON.parse(run('node', ['imp.mjs']));
    expect(keys).toEqual(expect.arrayContaining(EXPECTED));
  });

  it('require() and import expose the same API', () => {
    writeFileSync(join(dir, 'both.mjs'), [
      `import { createRequire } from 'node:module';`,
      `import * as esm from 'nostr-chunked-events';`,
      `const cjs = createRequire(import.meta.url)('nostr-chunked-events');`,
      `console.log(JSON.stringify([Object.keys(esm).sort(), Object.keys(cjs).sort()]));`,
    ].join('\n'));
    const [esm, cjs] = JSON.parse(run('node', ['both.mjs']));
    expect(cjs).toEqual(esm);
  });

  it('resolves types for both require and import (moduleResolution node16)', () => {
    writeFileSync(join(dir, 'a.cts'),
      `import { ChunkedFetcher } from 'nostr-chunked-events';\nexport const f: typeof ChunkedFetcher = ChunkedFetcher;\n`);
    writeFileSync(join(dir, 'b.mts'),
      `import { ChunkedPublisher } from 'nostr-chunked-events';\nexport const p: typeof ChunkedPublisher = ChunkedPublisher;\n`);
    // skipLibCheck: nostr-tools ships ESM-only declarations, which are its own
    // concern. The consumer files themselves must still type-check, which fails
    // (TS1479) when the require condition resolves to ESM-flavoured types.
    run('node', [join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict',
      '--module', 'node16', '--moduleResolution', 'node16', '--skipLibCheck', 'a.cts', 'b.mts']);
  });

  it('ships a UMD build that registers a browser global', () => {
    const umd = readFileSync(join(dir, 'node_modules', 'nostr-chunked-events', pkg.browser), 'utf8');
    const sandbox: Record<string, unknown> = {
      NostrTools: {}, TextEncoder, TextDecoder, crypto: globalThis.crypto,
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    runInNewContext(umd, sandbox);
    const lib = sandbox.NostrChunkedEvents as Record<string, unknown>;
    expect(Object.keys(lib)).toEqual(expect.arrayContaining(EXPECTED));
  });
});
