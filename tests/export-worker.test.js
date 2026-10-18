import test from 'node:test';
import assert from 'node:assert/strict';
import GridManager from '../js/grid-manager.js';
import { installSTLExportWorker } from '../js/export-worker.js';

test('worker protocol generates transferable STL buffers with OffscreenCanvas and releases snapshots', t => {
    const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    const pixels = new Uint8ClampedArray(256 * 256 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 255;
    }
    globalThis.OffscreenCanvas = class {
        constructor(width, height) { this.width = width; this.height = height; }
        getContext() { return { filter: 'none', drawImage() {}, getImageData: () => ({ data: pixels }) }; }
    };
    t.after(() => {
        if (originalOffscreenCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', originalOffscreenCanvas);
        else delete globalThis.OffscreenCanvas;
    });

    const messages = [];
    let closed = false;
    let workerClosed = false;
    const scope = {
        postMessage(message, transfer = []) { messages.push({ message, transfer }); },
        close() { workerClosed = true; }
    };
    installSTLExportWorker(scope);
    const grid = new GridManager();
    grid.updateConfig({ columns: 1, rows: 1, hexSize: 20, frameEnable: false });
    const cell = { ...grid.getAllCells()[0], imageId: 'fixture' };
    const bitmap = { width: 12, height: 12, close() { closed = true; } };

    scope.onmessage({ data: { type: 'init', images: [{ id: 'fixture', bitmap }] } });
    assert.equal(messages[0].message.type, 'ready');
    scope.onmessage({ data: {
        type: 'generate', requestId: 4, cell, gridConfig: grid.config,
        options: { sectors: 30, rings: 5, blur: 0 }
    } });
    const result = messages[1];
    assert.equal(result.message.type, 'result');
    assert.equal(result.message.requestId, 4);
    assert.ok(result.message.buffer instanceof ArrayBuffer);
    assert.deepEqual(result.transfer, [result.message.buffer]);

    scope.onmessage({ data: { type: 'dispose' } });
    assert.equal(closed, true);
    assert.equal(workerClosed, true);
});
