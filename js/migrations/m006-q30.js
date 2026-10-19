/**
 * Migration handler `m006-q30` — browser executor (DOCS/dataset-migrations/SPEC.md §15.4).
 *
 * Format 5 → 6: every level keeps its lossless `ll` column and gets ONE display column, `q30`
 * (WebP lossy at quality 30 of the 80-px-pitch mosaic + a dead-zone byte τ ∈ 0..12, or the
 * `ll` image + 0xFF when that is not larger). A unit is one 4×4×4 super-block of `ll` bricks
 * (key `t.k.c.z.y.x`); the server names its bricks (`unit_inputs`: `bricks` = byte runs of
 * the `ll` packs), the worker reads them through `read_ranges`, decodes each, encodes it in
 * `q30` with the m005 handler's own encoder (format5.py:encode_brick, the same arithmetic) and
 * posts the blob `u32 n, n × {u32 bz, by, bx}, n × u32 length, payloads` in (bz, by, bx) order.
 * No unit depends on another.
 *
 * Handler contract: see js/workers/migration-worker.js.
 */
(function (root) {
    'use strict';

    const ID = 'm006-q30';
    const DEP = 'm005-matrix';

    function fail(code, message, fatal) {
        return Object.assign(new Error(message || code), { code, fatal: fatal !== false });
    }

    function m005() {
        const h = root.LumenMigrationHandlers && root.LumenMigrationHandlers[DEP];
        if (!h || !h._internals) throw fail('no_handler', 'the m005 encoder is not loaded');
        return h._internals;
    }

    function aborted(io) {
        if (io && io.signal && io.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    async function prepare() { return { id: ID }; }

    function listUnits() { return []; }

    async function planUnitWork(key, state, io) {
        if (!io || typeof io.unitInputs !== 'function') throw fail('no_unit_inputs', 'this worker cannot ask the server for unit inputs');
        const inp = await io.unitInputs();
        if (!inp || inp.unit !== key) throw fail('bad_unit_inputs', 'unit_inputs answered another unit');
        return inp;
    }

    async function runUnit(inp, state, io) {
        if (inp.empty) throw fail('empty_unit', 'the server lists no work for ' + inp.unit);
        const M = m005();
        const bricks = inp.bricks || [];
        if (!bricks.length) throw fail('bad_unit_inputs', 'a non-empty unit without bricks');
        const read = await M.readRuns(io, bricks, () => false);
        const out = [];
        for (let n = 0; n < bricks.length; n++) {
            aborted(io);
            const r = bricks[n];
            const img = await M.decodeWebp(read.data[n]);
            if (img.width !== M.M66_W || img.height !== M.M66_H) throw fail('brick_undecodable', `ll brick is ${img.width}×${img.height}`);
            const b66 = M.unmosaic66(img.data);
            out.push({ bz: r.bz, by: r.by, bx: r.bx, enc: { q30: await M.encodeBrick(b66, 'q30', { ll: read.data[n] }) } });
        }
        return { body: M.brickBlob(out, ['q30']), bytesIn: read.bytesIn, tiles: out.length };
    }

    /** WebP lossless decode + lossy encode at the mosaic's size: the m005 probe covers both. */
    async function probe() {
        const h = root.LumenMigrationHandlers && root.LumenMigrationHandlers[DEP];
        if (!h || typeof h.probe !== 'function') return { available: false, reasons: ['no_handler'] };
        const r = await h.probe();
        return { available: !!r.available, reasons: (r.reasons || []).filter((x) => x !== 'no_compression_stream') };
    }

    const handler = {
        id: ID,
        requires: [DEP],
        // A unit holds ≤ 64 decoded bricks of 66³ (18 MB) and their encodings.
        slotsPerWorker: 1,
        batchUnits: 16,
        prepare, listUnits, planUnitWork, runUnit, probe,
    };
    root.LumenMigrationHandlers = root.LumenMigrationHandlers || {};
    root.LumenMigrationHandlers[ID] = handler;
})(typeof self !== 'undefined' ? self : globalThis);
