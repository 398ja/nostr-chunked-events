/**
 * L1 / mutant M19: the chunkSize guard in createChunks / createSnapshotChunks.
 *
 * Without the guard, a chunkSize smaller than one UTF-8 code point loops
 * forever. A synchronous loop blocks the test's own thread, so a vitest
 * timeout can never fire. The call runs in a worker thread instead, bundled
 * from the source with esbuild, and the worker is killed after a deadline:
 * a hang fails this test instead of hanging the suite. The same harness, with
 * a capped heap, covers the 1e9-chunk bound in validateChunks, whose absence
 * exhausts memory rather than failing an assertion.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const DEADLINE_MS = 5_000;

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  external: ['nostr-tools'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;

type Outcome = { threw: string } | { returned: number } | { hung: true } | { crashed: string };

function runIsolated(call: string): Promise<Outcome> {
  const source = `
    const { parentPort } = require('node:worker_threads');
    const module = { exports: {} };
    (function (module, exports) { ${bundle} })(module, module.exports);
    const lib = module.exports;
    try { const r = (${call}); parentPort.postMessage({ returned: typeof r === 'string' ? r.length : r.length ?? Number(r.valid) }); }
    catch (e) { parentPort.postMessage({ threw: e.constructor.name }); }
  `;
  return new Promise((resolve) => {
    // A capped heap turns "allocates gigabytes" into a quick worker crash.
    const worker = new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ hung: true });
    }, DEADLINE_MS);
    worker.once('message', (outcome: Outcome) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      resolve({ crashed: String(error) });
    });
  });
}

describe('chunkSize guard (timeout-guarded)', () => {
  it.each([
    ["lib.createChunks('😀😀', { chunkSize: 2 })"],
    ["lib.createChunks('abcdef', { chunkSize: 0 })"],
    ["lib.createSnapshotChunks('😀😀', { chunkSize: 3 })"],
  ])('%s throws RangeError instead of looping forever', async (call) => {
    expect(await runIsolated(call)).toEqual({ threw: 'RangeError' });
  }, DEADLINE_MS * 2);

  it('validateChunks refuses a total of 1e9 without allocating per-index bookkeeping', async () => {
    expect(await runIsolated("lib.validateChunks([{ index: 0, total: 1e9, data: 'x' }])")).toEqual({ returned: 0 });
    expect(await runIsolated("lib.reassembleChunks([{ index: 0, total: 1e9, data: 'x' }])")).toEqual({ threw: 'Error' });
  }, DEADLINE_MS * 2);

  it('the harness itself reports a real result for a valid chunkSize', async () => {
    expect(await runIsolated("lib.createChunks('😀😀', { chunkSize: 4 })")).toEqual({ returned: 2 });
  }, DEADLINE_MS * 2);
});
