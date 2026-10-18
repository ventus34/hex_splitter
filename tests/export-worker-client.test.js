import test from 'node:test';
import assert from 'node:assert/strict';
import ExportWorkerClient from '../js/export-worker-client.js';

class FakeWorker {
    constructor() {
        this.messages = [];
        this.terminated = false;
    }

    postMessage(message, transfer = []) {
        this.messages.push({ message, transfer });
        if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
        if (message.type === 'generate') {
            this.lastRequest = message;
            this.resolveRequest = () => {
                const buffer = new ArrayBuffer(4);
                this.onmessage?.({ data: { type: 'result', requestId: message.requestId, buffer } });
            };
        }
    }

    terminate() { this.terminated = true; }
}

function processorWithBitmap() {
    const bitmap = { close() {}, width: 5, height: 5 };
    return { images: new Map([['image-1', { imgElement: bitmap }]]), bitmap };
}

test('worker client transfers image snapshots once and returns STL ArrayBuffers', async () => {
    const worker = new FakeWorker();
    const client = new ExportWorkerClient({ workerFactory: () => worker });
    const processor = processorWithBitmap();
    await client.initialize(processor);

    assert.equal(worker.messages[0].message.type, 'init');
    assert.deepEqual(worker.messages[0].transfer, [processor.bitmap]);
    const resultPromise = client.generate({ imageId: 'image-1' }, { hexSize: 20 }, { rings: 5 });
    worker.resolveRequest();
    const result = await resultPromise;
    assert.ok(result instanceof ArrayBuffer);
    assert.equal(result.byteLength, 4);
    assert.equal(worker.messages[1].message.type, 'generate');
    client.terminate();
    assert.equal(worker.terminated, true);
});

test('aborting a worker request terminates the worker and rejects with AbortError', async () => {
    const worker = new FakeWorker();
    const client = new ExportWorkerClient({ workerFactory: () => worker });
    await client.initialize(processorWithBitmap());
    const controller = new AbortController();
    const request = client.generate({ imageId: 'image-1' }, {}, {}, { signal: controller.signal });
    controller.abort();

    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(worker.terminated, true);
    assert.equal(client.pending.size, 0);
});
