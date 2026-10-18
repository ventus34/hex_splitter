import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { createStaticServer } from '../server/static-server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#bbb"/><path d="M8 52 24 10l16 42 16-42 16 42" fill="none" stroke="#222" stroke-width="6"/></svg>'
);

let server;
let browser;
let baseUrl;
let context;
let page;
let dialogs = [];
let pageErrors = [];
let consoleErrors = [];

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

beforeEach(async () => {
    dialogs = [];
    pageErrors = [];
    consoleErrors = [];
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('dialog', async dialog => {
        dialogs.push(dialog.message());
        await dialog.accept();
    });
    await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.__exportWorkers = [];
        const records = new WeakMap();
        window.Worker = class TrackedWorker extends NativeWorker {
            constructor(scriptUrl, options) {
                super(scriptUrl, options);
                const record = {
                    scriptUrl: String(scriptUrl),
                    options: { ...options },
                    sent: [],
                    responses: [],
                    terminated: false
                };
                records.set(this, record);
                window.__exportWorkers.push(record);
                this.addEventListener('message', event => record.responses.push(event.data?.type));
            }

            postMessage(message, transfer) {
                this._record().sent.push({ type: message?.type, transferCount: transfer?.length ?? 0 });
                return super.postMessage(message, transfer);
            }

            terminate() {
                this._record().terminated = true;
                return super.terminate();
            }

            _record() {
                return records.get(this);
            }
        };
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
        window.gridManager && window.imageProcessor && window.gridManager.getAllCells().length > 0
    ));
    await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
    await page.evaluate(() => {
        window.__downloads = [];
        window.saveAs = (blob, filename) => window.__downloads.push({ blob, filename });
    });
});

afterEach(async () => {
    await context?.close();
    context = undefined;
});

async function setNumber(selector, value) {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).dispatchEvent('input');
}

async function prepareImageGrid(columns, rows) {
    await setNumber('#grid-cols', columns);
    await setNumber('#grid-rows', rows);
    await page.locator('#file-input').setInputFiles({
        name: 'worker-relief.svg',
        mimeType: 'image/svg+xml',
        buffer: fixtureSvg
    });
    await page.waitForFunction(({ columns: expectedColumns, rows: expectedRows }) => {
        const active = window.gridManager?.getActiveCells() || [];
        return window.gridManager.config.columns === expectedColumns &&
            window.gridManager.config.rows === expectedRows &&
            window.imageProcessor?.getAllImages().length === 1 &&
            active.length === expectedColumns * expectedRows &&
            active.every(cell => Boolean(cell.imageId));
    }, { columns, rows });
}

async function getDownloadBytes(index = 0) {
    return page.evaluate(async downloadIndex => {
        const download = window.__downloads[downloadIndex];
        return {
            filename: download.filename,
            bytes: Array.from(new Uint8Array(await download.blob.arrayBuffer()))
        };
    }, index).then(result => ({ filename: result.filename, bytes: Buffer.from(result.bytes) }));
}

async function assertValidReliefArchive(bytes, expectedCount) {
    const archive = await JSZip.loadAsync(bytes);
    const names = Object.keys(archive.files).filter(name => !archive.files[name].dir);
    assert.equal(names.length, expectedCount);
    for (const name of names) {
        assert.match(name, /^hex_3d_.+\.stl$/);
        const stl = Buffer.from(await archive.file(name).async('nodebuffer'));
        const triangleCount = stl.readUInt32LE(80);
        assert.ok(triangleCount > 0, `${name} has no facets`);
        assert.equal(stl.length, 84 + triangleCount * 50, `${name} has an invalid binary STL size`);
    }
}

function assertNoWorkerLoadErrors() {
    const workerErrors = [...pageErrors, ...consoleErrors].filter(message =>
        /worker|content security|module script|mime type|failed to fetch/i.test(message)
    );
    assert.deepEqual(workerErrors, [], `module Worker/CSP errors: ${workerErrors.join('\n')}`);
}

test('relief export button uses a module Worker and downloads a valid binary STL archive', async () => {
    await prepareImageGrid(1, 1);
    await setNumber('#relief-sectors', 30);
    await setNumber('#relief-rings', 15);

    await page.locator('#btn-export-3d-hexes-stl').click();
    await page.waitForFunction(() => window.__downloads.length === 1, undefined, { timeout: 15000 });
    const workers = await page.evaluate(() => window.__exportWorkers);
    assert.equal(workers.length, 1);
    assert.match(workers[0].scriptUrl, /export-worker\.js/);
    assert.equal(workers[0].options.type, 'module');
    assert.deepEqual(workers[0].sent.map(message => message.type), ['init', 'generate']);
    assert.equal(workers[0].sent[0].transferCount, 1);

    const download = await getDownloadBytes();
    assert.equal(download.filename, 'hexsplitter_heksy_3d_stl.zip');
    await assertValidReliefArchive(download.bytes, 1);
    await page.waitForFunction(() => document.querySelector('#export-progress-wrapper').classList.contains('hidden'));
    assertNoWorkerLoadErrors();
});

test('high-resolution relief export stays responsive, cancels cleanly, then a smaller export succeeds', async () => {
    await prepareImageGrid(4, 3);
    await setNumber('#relief-sectors', 360);
    await setNumber('#relief-rings', 180);

    await page.locator('#btn-export-3d-hexes-stl').click();
    await page.waitForFunction(() => window.__exportWorkers.some(worker =>
        worker.sent.filter(message => message.type === 'generate').length >
        worker.responses.filter(type => type === 'result').length
    ));
    const stateBeforeCancel = await page.evaluate(() => {
        const worker = window.__exportWorkers[0];
        const generatedRequests = worker.sent.filter(message => message.type === 'generate').length;
        const finishedRequests = worker.responses.filter(type => type === 'result').length;
        return {
            generatedRequests,
            finishedRequests,
            cancelVisible: !document.getElementById('btn-cancel-export').disabled
        };
    });
    assert.ok(stateBeforeCancel.generatedRequests > stateBeforeCancel.finishedRequests,
        'a relief mesh should still be running in the Worker');
    assert.equal(stateBeforeCancel.cancelVisible, true);

    const heartbeatMs = await page.evaluate(async () => {
        const start = performance.now();
        const blur = document.getElementById('relief-blur');
        blur.value = '0.7';
        blur.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(resolve));
        return performance.now() - start;
    });
    assert.ok(heartbeatMs < 1000, `main-thread input/animation-frame took ${heartbeatMs.toFixed(1)}ms`);
    assert.equal(await page.locator('#val-relief-blur').textContent(), '0.7px');

    await page.locator('#btn-cancel-export').click();
    await page.waitForFunction(() => window.__exportWorkers[0]?.terminated === true);
    await page.waitForFunction(() => document.querySelector('#export-progress-wrapper').classList.contains('hidden'));
    await page.waitForFunction(() => document.getElementById('btn-cancel-export').disabled);
    assert.equal(await page.evaluate(() => window.__downloads.length), 0, 'cancelled export must not download a partial archive');
    assert.ok(dialogs.some(message => /cancel|anul/i.test(message)), `missing localized cancellation notice: ${dialogs}`);

    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__downloads.length), 0);

    await setNumber('#grid-cols', 1);
    await setNumber('#grid-rows', 1);
    await setNumber('#relief-sectors', 30);
    await setNumber('#relief-rings', 15);
    await page.waitForFunction(() => {
        const cells = window.gridManager?.getActiveCells() || [];
        return cells.length === 1 && Boolean(cells[0].imageId);
    });
    await page.locator('#btn-export-3d-hexes-stl').click();
    await page.waitForFunction(() => window.__downloads.length === 1, undefined, { timeout: 15000 });

    const workers = await page.evaluate(() => window.__exportWorkers);
    assert.equal(workers.length, 2);
    assert.deepEqual(workers[1].sent.map(message => message.type), ['init', 'generate']);
    const download = await getDownloadBytes();
    await assertValidReliefArchive(download.bytes, 1);
    await page.waitForFunction(() => document.querySelector('#export-progress-wrapper').classList.contains('hidden'));
    assertNoWorkerLoadErrors();
});
