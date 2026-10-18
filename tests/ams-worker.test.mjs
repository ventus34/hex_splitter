import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createStaticServer } from '../server/static-server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server;
let browser;
let baseUrl;

before(async () => {
    server = createStaticServer({ root: repoRoot });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const launchOptions = { headless: true };
    if (process.env.CHROME_CHANNEL) launchOptions.channel = process.env.CHROME_CHANNEL;
    browser = await chromium.launch(launchOptions);
});

after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
});

async function openPreview(t) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.preview && window.gridManager?.getAllCells().length));
    await page.locator('.tab-btn[data-tab="tab-preview"]').click();
    await page.waitForFunction(() => document.querySelector('#preview-canvas')?.width > 0);
    await page.waitForFunction(() => window.preview?.renderRequested === false);
    return page;
}

test('module worker output matches the deterministic synchronous quantizer', async t => {
    const page = await openPreview(t);
    const result = await page.evaluate(async () => {
        const { quantizeRgbaPixels } = await import('/js/ams-quantizer.js');
        const width = 40;
        const height = 20;
        const source = new Uint8ClampedArray(width * height * 4);
        const colors = [[220, 32, 32], [32, 210, 64], [36, 64, 224], [220, 180, 28]];
        for (let i = 0; i < source.length; i += 4) {
            const color = colors[(i / 4) % colors.length];
            source[i] = color[0];
            source[i + 1] = color[1];
            source[i + 2] = color[2];
            source[i + 3] = i % 20 === 0 ? 40 : 255;
        }
        const expected = new Uint8ClampedArray(source);
        quantizeRgbaPixels(expected, 3);

        const worker = new Worker(new URL('/js/ams-quantizer.worker.js', location.origin), { type: 'module' });
        const response = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('AMS worker timed out')), 5000);
            worker.onerror = event => {
                clearTimeout(timeout);
                reject(new Error(event.message || 'AMS worker failed to load'));
            };
            worker.onmessage = event => {
                clearTimeout(timeout);
                resolve(event.data);
            };
            worker.postMessage({
                type: 'quantize', id: 7, key: 'fixture', width, height,
                colorCount: 3, pixels: source.buffer
            }, [source.buffer]);
        });
        worker.terminate();
        return {
            type: response.type,
            pixels: Array.from(new Uint8ClampedArray(response.pixels)),
            expected: Array.from(expected)
        };
    });

    assert.equal(result.type, 'quantized');
    assert.deepEqual(result.pixels, result.expected);
});

test('PreviewRenderer uses its module worker and caches the completed scene', async t => {
    const page = await openPreview(t);
    const key = await page.evaluate(() => {
        const preview = window.preview;
        preview.options = {
            ...preview.options,
            amsPreview: true,
            showFrames: false,
            showLabels: false,
            showRuler: false,
            showHangers: false
        };
        preview.render();
        return preview.getAmsCacheKey(window.gridManager.getActiveCells(), preview.canvas.width, preview.canvas.height);
    });
    await page.waitForFunction(expectedKey => (
        window.preview.amsCacheKey === expectedKey
        && !window.preview.amsWorkerFailed
        && !window.preview.renderRequested
    ), key, { timeout: 15000 });

    const state = await page.evaluate(() => ({
        key: window.preview.amsCacheKey,
        workerAvailable: window.preview.amsQuantizer.available,
        running: window.preview.amsQuantizer.runningKey
    }));
    assert.equal(state.key, key);
    assert.equal(state.workerAvailable, true);
    assert.equal(state.running, null);
});

test('AMS worker discards stale scenes, coalesces pan/cell/crop changes, and reuses the latest cache', async t => {
    const page = await openPreview(t);
    const setup = await page.evaluate(async () => {
        const { quantizeRgbaPixels } = await import('/js/ams-quantizer.js');
        window.__amsQuantize = quantizeRgbaPixels;
        window.__amsWorkers = [];

        const makeWorker = () => {
            const worker = {
                requests: [],
                terminated: false,
                postMessage(message, transfer) {
                    this.requests.push(structuredClone(message, { transfer }));
                },
                complete(index = 0) {
                    const request = this.requests[index];
                    const pixels = new Uint8ClampedArray(request.pixels);
                    window.__amsQuantize(pixels, request.colorCount);
                    this.onmessage({ data: { ...request, type: 'quantized', pixels: pixels.buffer } });
                },
                terminate() { this.terminated = true; }
            };
            window.__amsWorkers.push(worker);
            return worker;
        };

        const preview = window.preview;
        preview.createAmsWorker = makeWorker;
        preview.options = {
            ...preview.options,
            background: 'transparent',
            amsPreview: true,
            amsColors: 3,
            showFrames: false,
            showLabels: false,
            showRuler: false,
            showHangers: false
        };

        const cells = window.gridManager.getActiveCells();
        const cell = cells[0];
        const other = cells.find(candidate => candidate !== cell);
        const { default: HexMath } = await import('/js/hex-math.js');
        const source = document.createElement('canvas');
        source.width = 48;
        source.height = 32;
        const sourceCtx = source.getContext('2d');
        const gradient = sourceCtx.createLinearGradient(0, 0, 48, 32);
        gradient.addColorStop(0, '#e22');
        gradient.addColorStop(1, '#26e');
        sourceCtx.fillStyle = gradient;
        sourceCtx.fillRect(0, 0, 48, 32);
        const id = 'ams-worker-fixture';
        window.imageProcessor.images.set(id, {
            id,
            name: id,
            imgElement: source,
            width: source.width,
            height: source.height,
            rotatedCanvas: null
        });
        cell.imageId = id;
        cell.cropRegion = { x: 0, y: 0, w: 48, h: 32 };
        preview.render();
        const keyA = preview.amsQuantizer.runningKey;

        const centerMm = HexMath.axialToPixel(
            cell.q,
            cell.r,
            window.gridManager.config.hexSize,
            window.gridManager.config.orientation,
            window.gridManager.config.gap,
            window.gridManager.config.stagger
        );
        const center = window.preview.worldToScreen(centerMm.x, centerMm.y);
        const sample = {
            x: Math.max(0, Math.min(preview.canvas.width - 1, Math.round(center.x))),
            y: Math.max(0, Math.min(preview.canvas.height - 1, Math.round(center.y)))
        };
        const readPixel = (canvas, point) => Array.from(canvas.getContext('2d').getImageData(point.x, point.y, 1, 1).data);
        const rawVisibleMatches = JSON.stringify(readPixel(preview.canvas, sample))
            === JSON.stringify(readPixel(preview.offscreenCanvas, sample));

        preview.panX += 11;
        preview.render();
        const keyB = preview.amsQuantizer.pendingKey;
        other.enabled = false;
        preview.render();
        const keyActiveChange = preview.amsQuantizer.pendingKey;
        cell.cropRegion = { x: 4, y: 0, w: 40, h: 32 };
        preview.render();
        const keyC = preview.amsQuantizer.pendingKey;

        return {
            keyA,
            keyB,
            keyActiveChange,
            keyC,
            sample,
            rawVisibleMatches,
            workerCount: window.__amsWorkers.length,
            initialRequestCount: window.__amsWorkers[0].requests.length,
            cacheBeforeWorker: preview.amsCacheKey
        };
    });

    assert.equal(setup.workerCount, 1);
    assert.equal(setup.initialRequestCount, 1, 'pan/cell/crop changes should not start parallel workers');
    assert.ok(setup.keyA && setup.keyB && setup.keyActiveChange && setup.keyC);
    assert.notEqual(setup.keyA, setup.keyB, 'pan should invalidate the scene');
    assert.notEqual(setup.keyB, setup.keyActiveChange, 'active-cell changes should invalidate the scene');
    assert.notEqual(setup.keyActiveChange, setup.keyC, 'crop changes should invalidate the scene');
    assert.equal(setup.rawVisibleMatches, true, 'current unquantized pixels stay visible while the worker runs');
    assert.equal(setup.cacheBeforeWorker, null);

    const staleResult = await page.evaluate(() => {
        const preview = window.preview;
        window.__amsWorkers[0].complete(0);
        return {
            cacheKey: preview.amsCacheKey,
            posted: window.__amsWorkers[0].requests.length,
            secondKey: window.__amsWorkers[0].requests[1]?.key,
            currentKey: preview.amsQuantizer.runningKey
        };
    });
    assert.equal(staleResult.cacheKey, null, 'stale output must not enter the display cache');
    assert.equal(staleResult.posted, 2);
    assert.equal(staleResult.secondKey, setup.keyC, 'only the latest pending scene should be quantified');
    assert.equal(staleResult.currentKey, setup.keyC);

    await page.evaluate(() => window.__amsWorkers[0].complete(1));
    await page.waitForFunction(key => window.preview.amsCacheKey === key && !window.preview.renderRequested, setup.keyC);
    const reused = await page.evaluate(() => {
        const preview = window.preview;
        const before = window.__amsWorkers[0].requests.length;
        const key = preview.amsCacheKey;
        preview.render();
        return {
            key,
            after: window.__amsWorkers[0].requests.length,
            cachedKey: preview.amsCacheKey
        };
    });
    assert.equal(reused.key, setup.keyC);
    assert.equal(reused.after, 2, 'the same scene should reuse the worker result');
    assert.equal(reused.cachedKey, setup.keyC);
});

test('AMS work is canceled when preview is disabled, the canvas is empty, or pagehide fires', async t => {
    const page = await openPreview(t);
    const result = await page.evaluate(() => {
        const preview = window.preview;
        window.__amsWorkers = [];
        preview.createAmsWorker = () => {
            const worker = {
                terminated: false,
                postMessage() {},
                terminate() { this.terminated = true; }
            };
            window.__amsWorkers.push(worker);
            return worker;
        };
        preview.options.amsPreview = true;
        preview.render();
        const first = window.__amsWorkers[0];
        preview.options.amsPreview = false;
        preview.render();
        const offCanceled = first.terminated && preview.amsQuantizer.runningKey === null;

        preview.options.amsPreview = true;
        const oldWidth = preview.canvas.width;
        const oldHeight = preview.canvas.height;
        preview.canvas.width = 0;
        preview.render();
        const zeroCanceled = preview.amsQuantizer.runningKey === null && preview.amsQuantizer.pendingKey === null;
        preview.canvas.width = oldWidth;
        preview.canvas.height = oldHeight;
        preview.render();
        const second = window.__amsWorkers[1];
        window.dispatchEvent(new Event('pagehide'));
        const pagehideCanceled = second.terminated && preview.amsQuantizer.runningKey === null;
        return { offCanceled, zeroCanceled, pagehideCanceled, workerCount: window.__amsWorkers.length };
    });

    assert.equal(result.offCanceled, true);
    assert.equal(result.zeroCanceled, true);
    assert.equal(result.pagehideCanceled, true);
    assert.equal(result.workerCount, 2);
});
