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
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('dialog', async dialog => {
        dialogs.push(dialog.message());
        await dialog.accept();
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
        window.gridManager && window.imageProcessor && window.gridManager.getAllCells().length > 0
    ));
    await page.waitForFunction(() => window.canEditProject?.());
    await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
    await page.evaluate(() => {
        window.__downloads = [];
        window.__streamTrace = [];
        window.__streamByteChunks = [];
        window.__streamMaxActiveWrites = 0;
        window.__streamControls = { delayMs: 0, failAfterBytes: null, cancelPicker: false };
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

async function prepareImageGrid(columns = 2, rows = 1) {
    await setNumber('#grid-cols', columns);
    await setNumber('#grid-rows', rows);
    await page.locator('#file-input').setInputFiles({
        name: 'streaming-fixture.svg',
        mimeType: 'image/svg+xml',
        buffer: fixtureSvg
    });
    await page.waitForFunction(({ expectedColumns, expectedRows }) => {
        const cells = window.gridManager?.getActiveCells() || [];
        return window.gridManager.config.columns === expectedColumns &&
            window.gridManager.config.rows === expectedRows &&
            window.imageProcessor?.getAllImages().length === 1 &&
            cells.length === expectedColumns * expectedRows &&
            cells.every(cell => Boolean(cell.imageId));
    }, { expectedColumns: columns, expectedRows: rows });
}

async function installPicker() {
    await page.evaluate(() => {
        window.showSaveFilePicker = async options => {
            window.__streamTrace.push({
                type: 'picker',
                active: Boolean(navigator.userActivation?.isActive),
                suggestedName: options?.suggestedName,
                types: options?.types
            });
            if (window.__streamControls.cancelPicker) {
                throw new DOMException('The user cancelled the picker.', 'AbortError');
            }
            return {
                async createWritable() {
                    window.__streamTrace.push({ type: 'createWritable' });
                    let aborted = false;
                    let activeWrites = 0;
                    let maxActiveWrites = 0;
                    return {
                        async write(chunk) {
                            const bytes = chunk instanceof Uint8Array
                                ? new Uint8Array(chunk)
                                : chunk instanceof ArrayBuffer
                                    ? new Uint8Array(chunk.slice(0))
                                    : chunk instanceof Blob
                                        ? new Uint8Array(await chunk.arrayBuffer())
                                        : new TextEncoder().encode(String(chunk));
                            const index = window.__streamByteChunks.length;
                            activeWrites++;
                            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
                            window.__streamMaxActiveWrites = maxActiveWrites;
                            window.__streamTrace.push({ type: 'write-start', index, bytes: bytes.byteLength });
                            if (window.__streamControls.delayMs > 0) {
                                await new Promise(resolve => setTimeout(resolve, window.__streamControls.delayMs));
                            }
                            if (aborted) {
                                activeWrites--;
                                window.__streamTrace.push({ type: 'write-aborted', index });
                                throw new DOMException('The file sink was aborted.', 'AbortError');
                            }
                            window.__streamByteChunks.push(Array.from(bytes));
                            const byteCount = window.__streamByteChunks.reduce((sum, part) => sum + part.length, 0);
                            window.__streamTrace.push({ type: 'write-end', index, bytes: bytes.byteLength, byteCount });
                            if (window.__streamControls.failAfterBytes !== null &&
                                byteCount >= window.__streamControls.failAfterBytes) {
                                activeWrites--;
                                throw new Error('Injected disk write failure');
                            }
                            activeWrites--;
                        },
                        close() {
                            if (aborted) throw new DOMException('The file sink was aborted.', 'AbortError');
                            window.__streamTrace.push({ type: 'close' });
                        },
                        abort(reason) {
                            aborted = true;
                            window.__streamTrace.push({ type: 'abort', reason: String(reason ?? '') });
                        }
                    };
                }
            };
        };
    });
}

async function installOpfsPicker() {
    return page.evaluate(async () => {
        if (!navigator.storage?.getDirectory) throw new Error('The browser does not support OPFS.');
        const directory = await navigator.storage.getDirectory();
        const name = `hexsplitter-streaming-${crypto.randomUUID()}.zip`;
        const handle = await directory.getFileHandle(name, { create: true });
        let prototype = Object.getPrototypeOf(handle);
        while (prototype && !Object.prototype.hasOwnProperty.call(prototype, 'createWritable')) {
            prototype = Object.getPrototypeOf(prototype);
        }
        if (!prototype) throw new Error('The OPFS file handle has no createWritable method.');
        window.__opfsHandle = handle;
        window.__opfsFileName = name;
        window.__opfsHandlePrototype = prototype;
        window.__opfsNativeCreateWritable = prototype.createWritable;
        window.__opfsNativeHandleCreateWritable = prototype.createWritable.bind(handle);
        Object.defineProperty(handle, 'createWritable', {
            configurable: true,
            value: async options => {
                window.__streamTrace.push({ type: 'createWritable', options });
                try {
                    return await window.__opfsNativeHandleCreateWritable(options);
                } catch (error) {
                    window.__streamTrace.push({ type: 'createWritable-error', name: error?.name, message: error?.message });
                    throw error;
                }
            }
        });
        window.__opfsSeed = async contents => {
            const writable = await window.__opfsNativeCreateWritable.call(handle, { keepExistingData: false });
            await writable.write(new Blob([contents]));
            await writable.close();
        };
        await window.__opfsSeed('previous-complete-file');
        window.showSaveFilePicker = async options => {
            window.__streamTrace.push({
                type: 'picker',
                active: Boolean(navigator.userActivation?.isActive),
                suggestedName: options?.suggestedName
            });
            return handle;
        };
        return name;
    });
}

async function instrumentOpfsWrites({ delayMs = 0, failAfterBytes = null } = {}) {
    await page.evaluate(({ delay, failAfter }) => {
        window.__opfsDelayMs = delay;
        window.__opfsFailAfterBytes = failAfter;
        const nativeCreateWritable = window.__opfsNativeHandleCreateWritable;
        Object.defineProperty(window.__opfsHandle, 'createWritable', {
            configurable: true,
            writable: true,
            value: async function (options) {
                const nativeWritable = await nativeCreateWritable(options);
                let aborted = false;
                let bytesWritten = 0;
                return {
                    async write(chunk) {
                        const bytes = chunk instanceof Uint8Array
                            ? chunk.byteLength
                            : chunk instanceof Blob ? chunk.size
                                : chunk instanceof ArrayBuffer ? chunk.byteLength : 0;
                        window.__streamTrace.push({ type: 'write-start', bytes });
                        if (window.__opfsDelayMs > 0) {
                            await new Promise(resolve => setTimeout(resolve, window.__opfsDelayMs));
                        }
                        if (aborted) {
                            window.__streamTrace.push({ type: 'write-aborted' });
                            throw new DOMException('The OPFS write was aborted.', 'AbortError');
                        }
                        await nativeWritable.write(chunk);
                        bytesWritten += bytes;
                        window.__streamTrace.push({ type: 'write-end', bytes, bytesWritten });
                        if (window.__opfsFailAfterBytes !== null && bytesWritten >= window.__opfsFailAfterBytes) {
                            throw new Error('Injected OPFS write failure');
                        }
                    },
                    async close() {
                        window.__streamTrace.push({ type: 'close' });
                        return nativeWritable.close();
                    },
                    async abort(reason) {
                        aborted = true;
                        window.__streamTrace.push({ type: 'abort', reason: String(reason ?? '') });
                        return nativeWritable.abort(reason);
                    }
                };
            }
        });
    }, { delay: delayMs, failAfter: failAfterBytes });
}

async function readOpfsFile() {
    return page.evaluate(async () => {
        const file = await window.__opfsHandle.getFile();
        return Array.from(new Uint8Array(await file.arrayBuffer()));
    }).then(bytes => Buffer.from(bytes));
}

async function getStreamResult() {
    return page.evaluate(() => ({
        trace: window.__streamTrace,
        bytes: window.__streamByteChunks.flat(),
        downloads: window.__downloads.map(item => item.filename)
    })).then(result => ({ ...result, bytes: Buffer.from(result.bytes) }));
}

async function waitForExportEnd() {
    await page.waitForFunction(() => document.getElementById('export-progress-wrapper')?.classList.contains('hidden'));
    await page.waitForTimeout(50);
}

async function readZip(bytes) {
    return JSZip.loadAsync(bytes, { checkCRC32: true });
}

async function captureGenerationOrder() {
    await page.evaluate(() => {
        const original = HTMLCanvasElement.prototype.toBlob;
        let generation = 0;
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
            const current = ++generation;
            window.__streamTrace.push({ type: 'generation-start', index: current });
            return original.call(this, blob => {
                window.__streamTrace.push({ type: 'generation-end', index: current });
                callback(blob);
            }, ...args);
        };
    });
}

function assertClosedValidArchive(trace, bytes) {
    assert.ok(bytes.length > 22, 'the file sink should contain a nonempty ZIP');
    assert.ok(trace.some(event => event.type === 'close'), 'successful exports close the file sink');
    assert.equal(trace.some(event => event.type === 'abort'), false, 'successful exports do not abort the sink');
}

test('PNG ZIP streams to the picked file before generating the next cell and validates CRCs', async () => {
    await prepareImageGrid(2, 1);
    await installPicker();
    await captureGenerationOrder();

    await page.locator('#btn-export-hexes').click();
    await waitForExportEnd();

    const result = await getStreamResult();
    const picker = result.trace.find(event => event.type === 'picker');
    assert.equal(picker?.active, true, 'the save picker must run in the click user activation');
    assert.equal(picker?.suggestedName, 'hexsplitter_heksy.zip');
    assert.equal(result.downloads.length, 0, 'streaming file exports must not call saveAs(Blob)');
    assertClosedValidArchive(result.trace, result.bytes);

    const firstGeneration = result.trace.findIndex(event => event.type === 'generation-start' && event.index === 1);
    const secondGeneration = result.trace.findIndex(event => event.type === 'generation-start' && event.index === 2);
    const firstWrite = result.trace.findIndex(event => event.type === 'write-start');
    assert.ok(firstGeneration >= 0 && secondGeneration > firstGeneration, 'both PNG cells were generated');
    assert.ok(firstWrite > firstGeneration && firstWrite < secondGeneration,
        'the ZIP writer should emit the first entry before generating the next PNG');

    const zip = await readZip(result.bytes);
    const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
        assert.match(entry, /^hex_.+\.png$/);
        const png = Buffer.from(await zip.file(entry).async('nodebuffer'));
        assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
});

test('slow file writes apply backpressure before the following cell is generated', async () => {
    await prepareImageGrid(2, 1);
    await installPicker();
    await captureGenerationOrder();
    await page.evaluate(() => { window.__streamControls.delayMs = 100; });

    await page.locator('#btn-export-hexes').click();
    await waitForExportEnd();
    const result = await getStreamResult();

    const secondGeneration = result.trace.findIndex(event => event.type === 'generation-start' && event.index === 2);
    const firstWriteEnd = result.trace.findIndex(event => event.type === 'write-end');
    assert.ok(firstWriteEnd >= 0, 'the sink received file data');
    assert.ok(firstWriteEnd < secondGeneration,
        'a slow first write must settle before generating the next cell');
    assert.equal(await page.evaluate(() => window.__streamMaxActiveWrites), 1,
        'the ZIP writer should await each sink write before starting another');
    assertClosedValidArchive(result.trace, result.bytes);
    await readZip(result.bytes);
});

test('frame STL and relief STL ZIPs stream as valid CRC-checked archives', async () => {
    await setNumber('#grid-cols', 1);
    await setNumber('#grid-rows', 1);
    await page.waitForFunction(() => window.gridManager.config.columns === 1 && window.gridManager.config.rows === 1);
    await installPicker();

    await page.locator('#btn-export-frame-stl').click();
    await waitForExportEnd();
    let result = await getStreamResult();
    assert.equal(result.downloads.length, 0);
    let zip = await readZip(result.bytes);
    let names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^ramka_.+\.stl$/);
    assert.match(await zip.file(names[0]).async('text'), /^solid /);
    assertClosedValidArchive(result.trace, result.bytes);

    await page.evaluate(() => {
        window.__streamTrace = [];
        window.__streamByteChunks = [];
    });
    await prepareImageGrid(1, 1);
    await setNumber('#relief-sectors', 30);
    await setNumber('#relief-rings', 15);
    await page.locator('#btn-export-3d-hexes-stl').click();
    await waitForExportEnd();
    result = await getStreamResult();
    zip = await readZip(result.bytes);
    names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^hex_3d_.+\.stl$/);
    const stl = Buffer.from(await zip.file(names[0]).async('nodebuffer'));
    const triangleCount = stl.readUInt32LE(80);
    assert.ok(triangleCount > 0);
    assert.equal(stl.length, 84 + triangleCount * 50);
    assertClosedValidArchive(result.trace, result.bytes);
    assert.deepEqual(result.downloads, []);
});

test('cancel and disk write failure abort without committing, then a retry succeeds', async () => {
    await prepareImageGrid(3, 1);
    await installPicker();
    await page.evaluate(() => { window.__streamControls.delayMs = 120; });

    await page.locator('#btn-export-hexes').click();
    await page.waitForFunction(() => window.__streamTrace.some(event => event.type === 'write-start'));
    await page.locator('#btn-cancel-export').click();
    await waitForExportEnd();
    let result = await getStreamResult();
    assert.ok(result.trace.some(event => event.type === 'abort'), 'cancel must abort the open file sink');
    assert.equal(result.trace.some(event => event.type === 'close'), false, 'cancel must not commit the file');
    assert.equal(result.downloads.length, 0, 'cancel must not download a partial Blob');
    assert.ok(dialogs.some(message => /anul|cancel/i.test(message)));

    dialogs = [];
    await page.evaluate(() => {
        window.__streamTrace = [];
        window.__streamByteChunks = [];
        window.__streamControls.delayMs = 0;
        window.__streamControls.failAfterBytes = 100;
    });
    await page.locator('#btn-export-hexes').click();
    await waitForExportEnd();
    result = await getStreamResult();
    assert.ok(result.trace.some(event => event.type === 'abort'), 'write errors must abort the file sink');
    assert.equal(result.trace.some(event => event.type === 'close'), false, 'failed writes must not commit the file');
    assert.equal(result.downloads.length, 0, 'write errors must not fall back to a partial Blob');
    assert.ok(dialogs.some(message => /nie powiódł|failed/i.test(message)));

    dialogs = [];
    await page.evaluate(() => {
        window.__streamTrace = [];
        window.__streamByteChunks = [];
        window.__streamControls.failAfterBytes = null;
    });
    await page.locator('#btn-export-hexes').click();
    await waitForExportEnd();
    result = await getStreamResult();
    assertClosedValidArchive(result.trace, result.bytes);
    await readZip(result.bytes);
    assert.equal(result.downloads.length, 0);
});

test('cancelled picker is silent and leaves the next save usable', async () => {
    await prepareImageGrid(1, 1);
    await installPicker();
    await page.evaluate(() => { window.__streamControls.cancelPicker = true; });

    await page.locator('#btn-export-hexes').click();
    await page.waitForTimeout(100);
    assert.equal(dialogs.length, 0, 'user cancellation should not show an export failure alert');
    let result = await getStreamResult();
    assert.equal(result.downloads.length, 0);
    assert.equal(result.trace.some(event => event.type === 'createWritable'), false);

    await page.evaluate(() => {
        window.__streamTrace = [];
        window.__streamByteChunks = [];
        window.__streamControls.cancelPicker = false;
    });
    await page.locator('#btn-export-hexes').click();
    await waitForExportEnd();
    result = await getStreamResult();
    assertClosedValidArchive(result.trace, result.bytes);
    await readZip(result.bytes);
});

test('unsupported picker keeps the Blob download fallback', async () => {
    await prepareImageGrid(1, 1);
    await page.evaluate(() => { delete window.showSaveFilePicker; });

    await page.locator('#btn-export-hexes').click();
    await page.waitForFunction(() => window.__downloads.length === 1);
    await waitForExportEnd();

    const result = await page.evaluate(async () => ({
        filename: window.__downloads[0].filename,
        type: window.__downloads[0].blob.type,
        bytes: Array.from(new Uint8Array(await window.__downloads[0].blob.arrayBuffer())),
        pickerCalled: window.__streamTrace.some(event => event.type === 'picker')
    }));
    assert.equal(result.filename, 'hexsplitter_heksy.zip');
    assert.equal(result.type, 'application/zip');
    assert.equal(result.pickerCalled, false);
    await readZip(Buffer.from(result.bytes));
});

test('real OPFS file handle commits a valid ZIP and preserves the old file on cancel or write error', async () => {
    await prepareImageGrid(1, 1);
    await installOpfsPicker();

    await page.locator('#btn-export-hexes').click();
    await page.waitForFunction(async () => (await window.__opfsHandle.getFile()).size > 22, undefined, { timeout: 10000 });
    await waitForExportEnd();
    let trace = await page.evaluate(() => window.__streamTrace);
    assert.equal(trace.find(event => event.type === 'picker')?.active, true);
    assert.equal(trace.find(event => event.type === 'picker')?.suggestedName, 'hexsplitter_heksy.zip');
    assert.equal((await page.evaluate(() => window.__downloads.length)), 0);
    await readZip(await readOpfsFile());

    await page.evaluate(() => window.__opfsSeed('previous-complete-file'));
    await page.evaluate(() => { window.__streamTrace = []; });
    await instrumentOpfsWrites({ delayMs: 150 });
    await page.locator('#btn-export-hexes').click();
    await page.waitForFunction(() => window.__streamTrace.some(event => event.type === 'write-start'));
    await page.locator('#btn-cancel-export').click();
    await waitForExportEnd();
    trace = await page.evaluate(() => window.__streamTrace);
    assert.ok(trace.some(event => event.type === 'abort'), 'cancel must abort the real OPFS temporary file');
    assert.equal(trace.some(event => event.type === 'close'), false);
    assert.equal((await readOpfsFile()).toString(), 'previous-complete-file',
        'cancellation must preserve the previous committed file contents');

    dialogs = [];
    await page.evaluate(() => window.__opfsSeed('old-file-before-failure'));
    await page.evaluate(() => { window.__streamTrace = []; });
    await instrumentOpfsWrites({ failAfterBytes: 80 });
    await page.locator('#btn-export-hexes').click();
    await waitForExportEnd();
    trace = await page.evaluate(() => window.__streamTrace);
    assert.ok(trace.some(event => event.type === 'abort'), 'write failure must abort the real OPFS temporary file');
    assert.equal(trace.some(event => event.type === 'close'), false);
    assert.equal((await readOpfsFile()).toString(), 'old-file-before-failure',
        'a failed write must leave the previous committed file intact');
    assert.ok(dialogs.some(message => /nie powiódł|failed/i.test(message)));
});

test('project save can be cancelled while its database snapshot is pending', async () => {
    await prepareImageGrid(1, 1);
    await installPicker();
    await page.evaluate(async () => {
        const { default: Store } = await import('/js/project-store.js?v=1.0.3');
        const original = Store.getProjectSnapshot.bind(Store);
        const gate = new Promise(resolve => { window.__releaseProjectSnapshot = resolve; });
        Store.getProjectSnapshot = async () => {
            window.__projectSnapshotStarted = true;
            await gate;
            return original();
        };
    });
    await page.locator('#btn-save-project').click();
    await page.waitForFunction(() => window.__projectSnapshotStarted);
    await page.locator('#btn-cancel-export').click();
    await page.waitForFunction(() => !document.querySelector('.app-body').inert && !document.querySelector('.app-header').inert);
    await waitForExportEnd();
    const result = await getStreamResult();
    assert.ok(result.trace.some(event => event.type === 'abort'));
    assert.equal(result.trace.some(event => event.type === 'close'), false);
    assert.equal(result.downloads.length, 0);
    await page.evaluate(() => window.__releaseProjectSnapshot());
});

test('streamed .hexproj reimports with its image and transforms intact', async () => {
    await prepareImageGrid(1, 1);
    await setNumber('.rotation-number-input', 90);
    await page.waitForFunction(() => window.imageProcessor.getAllImages()[0]?.rotation === 90);
    await installPicker();

    await page.locator('#btn-save-project').click();
    await page.waitForFunction(() => window.__streamTrace.some(event => event.type === 'close'));
    let result = await getStreamResult();
    assert.equal(result.trace.find(event => event.type === 'picker')?.active, true);
    assert.equal(result.trace.find(event => event.type === 'picker')?.suggestedName, 'project.hexproj');
    assert.equal(result.downloads.length, 0);
    let zip = await readZip(result.bytes);
    const manifest = JSON.parse(await zip.file('project.json').async('text'));
    assert.equal(manifest.images[0].rotation, 90);
    assert.equal(manifest.images[0].mimeType, 'image/svg+xml');
    assert.ok(zip.file(manifest.images[0].filename));

    await setNumber('.rotation-number-input', 0);
    await page.waitForFunction(() => window.imageProcessor.getAllImages()[0]?.rotation === 0);
    await page.locator('#project-file-input').setInputFiles({
        name: 'streamed.hexproj',
        mimeType: 'application/zip',
        buffer: result.bytes
    });
    await page.waitForFunction(() => window.imageProcessor.getAllImages()[0]?.rotation === 90, undefined, { timeout: 10000 });
    assert.equal(await page.locator('.rotation-number-input').inputValue(), '90');

    await page.evaluate(() => {
        window.__downloads = [];
        window.__streamTrace = [];
        window.__streamByteChunks = [];
        window.__streamControls = { delayMs: 0, failAfterBytes: null, cancelPicker: false };
        window.saveAs = (blob, filename) => window.__downloads.push({ blob, filename });
    });
    await installPicker();
    await page.locator('#btn-save-project').click();
    await page.waitForFunction(() => window.__streamTrace.some(event => event.type === 'close'), undefined, { timeout: 10000 }).catch(async error => {
        const state = await page.evaluate(() => ({
            trace: window.__streamTrace,
            canEdit: window.canEditProject?.(),
            images: window.imageProcessor?.getAllImages().map(image => ({ id: image.id, rotation: image.rotation })),
            cells: window.gridManager?.getActiveCells().map(cell => ({ label: cell.label, imageId: cell.imageId })),
            hidden: document.getElementById('export-progress-wrapper')?.classList.contains('hidden'),
            progress: document.getElementById('export-progress-text')?.textContent
        }));
        throw new Error(`${error.message}; dialogs=${JSON.stringify(dialogs)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}; state=${JSON.stringify(state)}`);
    });
    result = await getStreamResult();
    zip = await readZip(result.bytes);
    assert.equal(JSON.parse(await zip.file('project.json').async('text')).images[0].rotation, 90);
});
