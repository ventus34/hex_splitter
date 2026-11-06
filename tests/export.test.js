import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import GridManager from '../js/grid-manager.js';
import ExportManager from '../js/export-manager.js';
import { getPanelGeometry, getPanelRaster, panelFilename } from '../js/panel-export.js';
import { i18n } from '../js/i18n.js';

function environment(t, { failOn = -1, onRender, cells = 2 } = {}) {
    const downloads = [], alerts = [], renders = [], bitmaps = [];
    const elements = new Map();
    const grid = new GridManager();
    grid.updateConfig({ columns: Math.min(cells, 25), rows: Math.ceil(cells / 25), dpi: 300, hexSize: 20 });
    grid.getAllCells().forEach(cell => { cell.imageId = 'fixture'; cell.cropRegion = { x: 1, y: 2, w: 40, h: 35 }; });
    class Processor {
        constructor() { this.images = new Map([['fixture', { id: 'fixture', imgElement: { width: 64, height: 32 } }]]); }
        getImage(id) { return this.images.get(id); }
        getRotatedCanvasOrImage(image) { return image.imgElement; }
        createHexagonCanvas(cell, snapshot) {
            renders.push({ dpi: snapshot.config.dpi, crop: { ...cell.cropRegion }, source: this.getImage(cell.imageId).imgElement.width });
            onRender?.(renders.length, grid, processor);
            const renderIndex = renders.length;
            return { width: 40, height: 35, toBlob(callback) { setTimeout(() => callback(renderIndex === failOn ? null : new Blob(['fixture-png'])), 1); } };
        }
    }
    const processor = new Processor();
    const overrides = {
        alert: value => alerts.push(value),
        saveAs: (blob, filename) => downloads.push({ blob, filename }),
        createImageBitmap: async source => {
            const bitmap = { width: source.width, height: source.height, closed: false, close() { this.closed = true; } };
            bitmaps.push(bitmap); return bitmap;
        },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { classList: { toggle(_name, hidden) { this.hidden = hidden; } }, style: {}, textContent: '' });
            return elements.get(id);
        } }
    };
    const originals = new Map(Object.keys(overrides).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, overrides);
    t.mock.method(console, 'error', () => {});
    t.after(() => { for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
    return { exporter: new ExportManager(grid, processor), grid, processor, downloads, alerts, renders, bitmaps, elements };
}

test('image export uses a snapshot when the live project changes between tiles', async t => {
    const env = environment(t, { onRender(index, grid, processor) {
        if (index !== 1) return;
        grid.config.dpi = 72;
        grid.getAllCells().forEach(cell => { cell.cropRegion.x = 999; cell.imageId = null; });
        processor.images.get('fixture').imgElement.width = 0;
        processor.images.clear();
    } });
    const result = await env.exporter.exportHexesZip();
    assert.equal(result.count, 2);
    assert.deepEqual(env.renders.map(render => [render.dpi, render.crop.x, render.source]), [[300, 1, 64], [300, 1, 64]]);
    assert.equal(env.downloads.length, 1);
    const archive = await JSZip.loadAsync(await env.downloads[0].blob.arrayBuffer());
    assert.deepEqual(Object.keys(archive.files).filter(name => !archive.files[name].dir), ['hex_A1.png', 'hex_B1.png']);
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
});

test('ZIP entries stream from Blob without copying each file into an ArrayBuffer', async t => {
    const env = environment(t, { cells: 1 });
    const blob = new Blob([new Uint8Array(256 * 1024).fill(7)]);
    Object.defineProperty(blob, 'arrayBuffer', { value() { throw new Error('entry Blob must be streamed'); } });

    const result = await env.exporter.runExport({
        filename: 'streamed.zip',
        progress: 'generating_hex_images',
        generate: () => ({ name: 'streamed.bin', blob })
    });

    assert.equal(result.count, 1);
    const archive = await JSZip.loadAsync(await env.downloads[0].blob.arrayBuffer());
    assert.equal((await archive.file('streamed.bin').async('uint8array')).length, blob.size);
});

test('runExport writes entries from a non-grid snapshot and starts its capture after the picker call', async t => {
    const env = environment(t, { cells: 1 });
    const previousPicker = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
    const events = [];
    globalThis.showSaveFilePicker = () => {
        events.push('picker');
        return Promise.resolve({
            createWritable: () => new WritableStream({
                write() {},
                close() { events.push('commit'); }
            })
        });
    };
    t.after(() => previousPicker
        ? Object.defineProperty(globalThis, 'showSaveFilePicker', previousPicker)
        : delete globalThis.showSaveFilePicker);

    let disposed = false;
    const blob = new Blob(['{"version":1}'], { type: 'application/json' });
    const result = await env.exporter.runExport({
        filename: 'project.hexproj',
        progress: 'generating_hex_images',
        captureSnapshot: signal => {
            events.push('snapshot');
            assert.equal(signal.aborted, false);
            return { entries: [{ label: 'project.json', name: 'project.json', blob }], dispose() { disposed = true; } };
        },
        selectEntries: snapshot => snapshot.entries,
        generate: entry => entry
    });

    assert.equal(result.count, 1);
    assert.equal(result.filename, 'project.hexproj');
    assert.equal(disposed, true);
    assert.deepEqual(events.slice(0, 2), ['picker', 'snapshot']);
    assert.equal(events.at(-1), 'commit');
});

test('runExport applies a caller byte cap to a non-grid archive', async t => {
    const env = environment(t, { cells: 1 });
    let disposed = false;
    await env.exporter.runExport({
        filename: 'project.hexproj',
        progress: 'generating_hex_images',
        captureSnapshot: () => ({
            entries: [{ label: 'project.json', name: 'project.json', blob: new Blob(['project data']) }],
            dispose() { disposed = true; }
        }),
        selectEntries: snapshot => snapshot.entries,
        generate: entry => entry,
        maxBytes: 8
    });

    assert.equal(disposed, true);
    assert.equal(env.downloads.length, 0);
    assert.match(env.alerts[0], new RegExp(i18n.t('export_too_large')));
    assert.equal(env.exporter.busy, false);
});

test('disk output streams archives larger than the former 256 MiB memory cap with one write in flight', async t => {
    const env = environment(t, { cells: 1 });
    const previousPicker = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
    const totalBytes = 257 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024);
    let bytesWritten = 0;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let committed = false;
    globalThis.showSaveFilePicker = () => Promise.resolve({
        createWritable: () => new WritableStream({
            async write(bytes) {
                activeWrites++;
                maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
                bytesWritten += bytes.byteLength;
                await Promise.resolve();
                activeWrites--;
            },
            close() { committed = true; }
        })
    });
    t.after(() => previousPicker
        ? Object.defineProperty(globalThis, 'showSaveFilePicker', previousPicker)
        : delete globalThis.showSaveFilePicker);

    const largeBlob = {
        size: totalBytes,
        stream() {
            let remaining = totalBytes;
            return new ReadableStream({
                pull(controller) {
                    if (remaining === 0) { controller.close(); return; }
                    const next = Math.min(chunk.byteLength, remaining);
                    controller.enqueue(next === chunk.byteLength ? chunk : chunk.subarray(0, next));
                    remaining -= next;
                }
            });
        }
    };
    const result = await env.exporter.runExport({
        filename: 'large-project.hexproj',
        progress: 'generating_hex_images',
        captureSnapshot: () => ({
            entries: [{ label: 'payload.bin', name: 'payload.bin', blob: largeBlob }],
            dispose() {}
        }),
        selectEntries: snapshot => snapshot.entries,
        generate: entry => entry
    });

    assert.ok(result.bytes > 256 * 1024 * 1024);
    assert.equal(bytesWritten, result.bytes);
    assert.equal(maxActiveWrites, 1);
    assert.equal(committed, true);
    assert.equal(env.downloads.length, 0);
    assert.equal(env.exporter.busy, false);
});

test('3D relief preflight uses the disk ZIP32 limit instead of the memory fallback cap', async t => {
    const env = environment(t, { cells: 625 });
    const globals = ['showSaveFilePicker', 'Worker', 'OffscreenCanvas'];
    const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let committed = false;
    let generated = 0;
    globalThis.showSaveFilePicker = () => Promise.resolve({
        createWritable: () => new WritableStream({ write() {}, close() { committed = true; } })
    });
    globalThis.OffscreenCanvas = class {};
    globalThis.Worker = class {
        postMessage(message) {
            if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
            if (message.type === 'generate') {
                generated++;
                const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
                queueMicrotask(() => this.onmessage?.({ data: { type: 'result', requestId: message.requestId, buffer } }));
            }
        }
        terminate() {}
    };
    t.after(() => {
        for (const key of globals) {
            const descriptor = previous.get(key);
            descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
        }
    });

    const result = await env.exporter.exportHexes3DStl({ sectors: 360, rings: 180, blur: 0 });

    assert.equal(result.count, 625);
    assert.equal(generated, 625);
    assert.equal(committed, true);
    assert.equal(env.downloads.length, 0);
    assert.equal(env.exporter.busy, false);
});

test('failed tile encoding downloads no partial archive and releases the export', async t => {
    const env = environment(t, { failOn: 2 });
    await env.exporter.exportHexesZip();
    assert.equal(env.downloads.length, 0);
    assert.match(env.alerts[0], /B1/);
    assert.equal(env.exporter.busy, false);
    assert.equal(env.elements.get('export-progress-wrapper').classList.hidden, true);
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
});

test('concurrent export requests do not create overlapping jobs', async t => {
    const env = environment(t);
    await Promise.all([env.exporter.exportHexesZip(), env.exporter.exportHexesZip()]);
    assert.equal(env.downloads.length, 1);
    assert.equal(env.alerts.length, 1);
    assert.match(env.alerts[0], /already running/);
});

test('oversized relief archive is refused before generating any tile', async t => {
    const env = environment(t, { cells: 625 });
    await env.exporter.exportHexes3DStl({ sectors: 360, rings: 180 });
    assert.equal(env.downloads.length, 0);
    assert.equal(env.renders.length, 0);
    assert.match(env.alerts[0], /memory limit/);
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
});

test('cancelling an in-flight tile releases the export without downloading a partial archive', async t => {
    const env = environment(t);
    let releaseGenerate;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const pendingOutput = new Promise(resolve => { releaseGenerate = resolve; });
    const exportPromise = env.exporter.runExport({
        filename: 'fixture.zip',
        progress: 'generating_hex_images',
        generate: () => { markStarted(); return pendingOutput; }
    });

    await started;
    assert.equal(env.exporter.cancel(), true);
    await exportPromise;
    assert.equal(env.exporter.busy, false);
    assert.equal(env.exporter.activeJob, null);
    assert.equal(env.downloads.length, 0);
    assert.equal(env.alerts[0], i18n.t('export_cancelled'));
    assert.equal(env.elements.get('btn-cancel-export').classList.hidden, true);

    releaseGenerate({ name: 'late.bin', blob: new Blob(['late']) });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(env.downloads.length, 0);
});

test('cancelling while image snapshots are being copied closes bitmaps that finish late', async t => {
    const env = environment(t);
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let finishCopy;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const copies = [];
    globalThis.createImageBitmap = source => {
        markStarted();
        return new Promise(resolve => {
            finishCopy = () => {
                const bitmap = { width: source.width, height: source.height, closed: false, close() { this.closed = true; } };
                copies.push(bitmap);
                resolve(bitmap);
            };
        });
    };
    t.after(() => { globalThis.createImageBitmap = originalCreateImageBitmap; });

    const exportPromise = env.exporter.runExport({
        withImages: true,
        filename: 'fixture.zip',
        progress: 'generating_hex_images',
        generate: () => ({ name: 'fixture.png', blob: new Blob(['fixture']) })
    });
    await started;
    env.exporter.cancel();
    await exportPromise;
    finishCopy();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(copies.length, 1);
    assert.equal(copies[0].closed, true);
    assert.equal(env.downloads.length, 0);
});

test('cancellation during ZIP writing aborts the destination and never downloads it', async t => {
    const env = environment(t, { cells: 1 });
    const originalShowProgress = env.exporter.showProgress.bind(env.exporter);
    let cancellationScheduled = false;
    env.exporter.showProgress = (show, text, percent) => {
        originalShowProgress(show, text, percent);
        if (show && text === i18n.t('writing_archive') && !cancellationScheduled) {
            cancellationScheduled = true;
            setTimeout(() => env.exporter.cancel(), 0);
        }
    };

    await env.exporter.runExport({
        filename: 'fixture.zip',
        progress: 'generating_hex_images',
        generate: () => ({ name: 'large.bin', blob: new Blob([new Uint8Array(2 * 1024 * 1024).fill(7)]) })
    });
    assert.equal(cancellationScheduled, true);
    assert.equal(env.downloads.length, 0);
    assert.equal(env.exporter.busy, false);
    assert.equal(env.alerts[0], i18n.t('export_cancelled'));
});

test('3D relief export uses a dedicated worker and packages its transferred STL result', async t => {
    const env = environment(t, { cells: 1 });
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    const workers = [];
    class WorkerFixture {
        constructor(url, options) { this.url = url; this.options = options; this.messages = []; this.terminated = false; workers.push(this); }
        postMessage(message, transfer = []) {
            this.messages.push({ message, transfer });
            if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
            if (message.type === 'generate') {
                const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
                queueMicrotask(() => this.onmessage?.({ data: { type: 'result', requestId: message.requestId, buffer } }));
            }
        }
        terminate() { this.terminated = true; }
    }
    globalThis.Worker = WorkerFixture;
    globalThis.OffscreenCanvas = class {};
    t.after(() => {
        if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
        else delete globalThis.Worker;
        if (originalOffscreenCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', originalOffscreenCanvas);
        else delete globalThis.OffscreenCanvas;
    });

    const result = await env.exporter.exportHexes3DStl({ sectors: 30, rings: 15, blur: 0 });
    assert.equal(result.count, 1);
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0].messages.map(item => item.message.type), ['init', 'generate']);
    assert.equal(workers[0].messages[0].transfer.length, 1);
    assert.equal(workers[0].options.type, 'module');
    assert.equal(workers[0].terminated, true);
    const archive = await JSZip.loadAsync(await env.downloads[0].blob.arrayBuffer());
    assert.deepEqual([...await archive.file('hex_3d_A1.stl').async('uint8array')], [1, 2, 3, 4]);
});

// Exercise the actual panel renderer and ZIP manager with a small Canvas test double;
// browser tests verify the pixel data produced by a real canvas.
function panelEnvironment(t, { onEncode } = {}) {
    const env = environment(t, { cells: 5 });
    const cells = env.grid.getAllCells();
    env.grid.panelExport = {
        gapMm: 0,
        groups: [
            { id: 'first', cells: cells.slice(0, 2).map(({ q, r }) => ({ q, r })) },
            { id: 'second', cells: cells.slice(2, 4).map(({ q, r }) => ({ q, r })) }
        ]
    };
    env.grid.config.exportFormat = 'jpg';
    const canvases = [];
    const encodedCanvases = [];
    const drawCalls = [];
    globalThis.document.createElement = tag => {
        assert.equal(tag, 'canvas');
        const context = {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
            clip() {}, translate() { this.translated = true; }, fill() {}, fillRect() {}, clearRect() {},
            drawImage(...args) { drawCalls.push({ args, translated: this.translated }); }
        };
        const canvas = {
            width: 0, height: 0,
            getContext(type) { assert.equal(type, '2d'); return context; },
            toBlob(callback, type) {
                assert.equal(type, 'image/png');
                canvas.encodedWidth = canvas.width;
                canvas.encodedHeight = canvas.height;
                encodedCanvases.push(canvas);
                const index = encodedCanvases.length;
                if (onEncode) onEncode({ index, callback, env, canvas });
                else callback(new Blob([`panel-${index}`], { type }));
            }
        };
        canvases.push(canvas);
        return canvas;
    };
    return { ...env, canvases, encodedCanvases, drawCalls };
}

test('panel ZIP uses one immutable snapshot for groups, spacing, crops and selected image sources', async t => {
    const env = panelEnvironment(t, { onEncode({ index, callback, env: live }) {
        if (index === 1) {
            live.grid.config.dpi = 72;
            live.grid.panelExport.gapMm = 50;
            live.grid.panelExport.groups.splice(1);
            for (const cell of live.grid.getAllCells()) cell.cropRegion.x = 999;
            live.processor.images.clear();
        }
        callback(new Blob([`panel-${index}`], { type: 'image/png' }));
    } });
    env.grid.getAllCells()[4].imageId = 'ungrouped';
    env.processor.images.set('ungrouped', { id: 'ungrouped', imgElement: { width: 100_000, height: 100_000 } });
    const expectedPanels = env.grid.panelExport.groups.map(group => {
        const geometry = getPanelGeometry(group, env.grid, env.grid.panelExport.gapMm);
        return { name: panelFilename(geometry), ...getPanelRaster(geometry, env.grid) };
    });

    const result = await env.exporter.exportGroupsZip();

    assert.equal(result.count, 2);
    assert.equal(result.filename, 'hexsplitter_panels.zip');
    assert.equal(env.bitmaps.length, 1, 'only grouped source images were snapshotted');
    assert.equal(env.downloads.length, 1);
    const archive = await JSZip.loadAsync(await env.downloads[0].blob.arrayBuffer());
    const names = Object.keys(archive.files).filter(name => !archive.files[name].dir);
    assert.equal(names.length, 2);
    for (let i = 0; i < names.length; i++) {
        assert.equal(names[i], expectedPanels[i].name, 'filename retains original spacing and labels');
        assert.equal(await archive.file(names[i]).async('string'), `panel-${i + 1}`);
        assert.equal(env.encodedCanvases[i].encodedWidth, expectedPanels[i].width, 'original DPI and spacing are retained');
        assert.equal(env.encodedCanvases[i].encodedHeight, expectedPanels[i].height);
    }
    const cropCalls = env.drawCalls.filter(call => call.translated && call.args.length === 9);
    assert.equal(cropCalls.length, 4, 'one source crop per grouped hex');
    assert.ok(cropCalls.every(call => Math.abs(call.args[1]) < 100), 'original crops retained after live edits');
    assert.ok(env.canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'output and scratch canvases are released');
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
    assert.equal(env.alerts.length, 0);
});

test('panel preflight rejects missing images before rendering any group', async t => {
    for (const missing of ['unassigned', 'missing-source']) {
        await t.test(missing, async t => {
            const env = panelEnvironment(t);
            const member = env.grid.getAllCells()[2];
            member.imageId = missing === 'unassigned' ? null : 'missing';
            await env.exporter.exportGroupsZip();
            assert.equal(env.canvases.length, 0);
            assert.equal(env.downloads.length, 0);
            assert.match(env.alerts[0], /source image is missing/i);
            assert.equal(env.exporter.busy, false);
            assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
        });
    }
});

test('panel preflight rejects oversized output before rendering and releases its snapshot', async t => {
    const env = panelEnvironment(t);
    env.grid.config.hexSize = 500;
    env.grid.config.dpi = 1200;
    await env.exporter.exportGroupsZip();
    assert.equal(env.canvases.length, 0);
    assert.equal(env.downloads.length, 0);
    assert.ok(env.alerts[0].includes(i18n.t('export_too_large')));
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
    assert.equal(env.exporter.busy, false);
});

test('failure to encode a later panel aborts the ZIP and releases canvases', async t => {
    const env = panelEnvironment(t, { onEncode({ index, callback }) {
        callback(index === 2 ? null : new Blob(['png'], { type: 'image/png' }));
    } });
    await env.exporter.exportGroupsZip();
    assert.equal(env.encodedCanvases.length, 2);
    assert.equal(env.downloads.length, 0);
    assert.match(env.alerts[0], /no file could be generated/i);
    assert.ok(env.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
    assert.equal(env.exporter.busy, false);
});

test('cancelling during panel encoding aborts ZIP and releases a late canvas result', async t => {
    let releaseEncode, notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const env = panelEnvironment(t, { onEncode({ callback }) { releaseEncode = callback; notifyStarted(); } });
    const exporting = env.exporter.exportGroupsZip();
    await started;
    assert.equal(env.exporter.cancel(), true);
    await exporting;
    assert.equal(env.downloads.length, 0);
    assert.equal(env.exporter.busy, false);
    assert.equal(env.alerts[0], i18n.t('export_cancelled'));
    assert.ok(env.bitmaps.every(bitmap => bitmap.closed));
    releaseEncode(new Blob(['late'], { type: 'image/png' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(env.encodedCanvases[0].width, 0);
    assert.equal(env.encodedCanvases[0].height, 0);
    assert.ok(env.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(env.downloads.length, 0);
});
