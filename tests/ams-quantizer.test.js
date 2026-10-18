import assert from 'node:assert/strict';
import { test } from 'node:test';
import AmsQuantizerClient from '../js/ams-quantizer-client.js';
import { quantizeRgbaPixels } from '../js/ams-quantizer.js';

function makePixels() {
    const data = new Uint8ClampedArray(40 * 20 * 4);
    const colors = [
        [224, 30, 30],
        [24, 200, 52],
        [30, 80, 224],
        [230, 190, 20]
    ];
    for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 40; x++) {
            const offset = (y * 40 + x) * 4;
            const [red, green, blue] = colors[(Math.floor(x / 10) + Math.floor(y / 10)) % colors.length];
            data[offset] = red;
            data[offset + 1] = green;
            data[offset + 2] = blue;
            data[offset + 3] = (x + y) % 7 === 0 ? 40 : 255;
        }
    }
    return data;
}

test('pure AMS quantizer is deterministic and preserves alpha and transparent pixels', () => {
    const first = makePixels();
    const second = makePixels();
    const original = makePixels();
    quantizeRgbaPixels(first, 3);
    quantizeRgbaPixels(second, 3);

    assert.deepEqual(first, second);
    for (let i = 0; i < first.length; i += 4) {
        assert.equal(first[i + 3], original[i + 3]);
        if (first[i + 3] <= 50) {
            assert.equal(first[i], original[i]);
            assert.equal(first[i + 1], original[i + 1]);
            assert.equal(first[i + 2], original[i + 2]);
        }
    }
    assert.notDeepEqual(first, original, 'opaque colors should be mapped to the limited palette');
});

test('quantizer client transfers one running job and only the latest pending scene', () => {
    const workers = [];
    const results = [];
    let currentKey = 'scene-a';

    class FakeWorker {
        constructor() {
            this.requests = [];
            this.terminated = false;
            workers.push(this);
        }
        postMessage(message, transfer) {
            this.requests.push(structuredClone(message, { transfer }));
        }
        complete(index = 0) {
            const request = this.requests[index];
            const pixels = new Uint8ClampedArray(request.pixels);
            quantizeRgbaPixels(pixels, request.colorCount);
            this.onmessage({ data: { ...request, type: 'quantized', pixels: pixels.buffer } });
        }
        terminate() { this.terminated = true; }
    }

    const client = new AmsQuantizerClient({
        workerFactory: () => new FakeWorker(),
        isCurrent: job => job.key === currentKey,
        onResult: result => results.push(result)
    });
    const makeJob = key => ({
        key,
        width: 40,
        height: 20,
        colorCount: 3,
        readImageData: () => ({ data: makePixels() })
    });

    assert.equal(client.submit(makeJob('scene-a')), true);
    currentKey = 'scene-b';
    assert.equal(client.submit(makeJob('scene-b')), true);
    currentKey = 'scene-c';
    assert.equal(client.submit(makeJob('scene-c')), true);
    assert.equal(client.runningKey, 'scene-a');
    assert.equal(client.pendingKey, 'scene-c');
    assert.equal(workers[0].requests.length, 1);

    workers[0].complete();
    assert.equal(results.length, 0, 'stale worker result must be discarded');
    assert.equal(workers[0].requests.length, 2);
    assert.equal(workers[0].requests[1].key, 'scene-c', 'intermediate scene is coalesced away');

    workers[0].complete(1);
    assert.equal(results.length, 1);
    assert.equal(results[0].key, 'scene-c');
    assert.deepEqual(new Uint8ClampedArray(results[0].pixels), (() => {
        const expected = makePixels();
        quantizeRgbaPixels(expected, 3);
        return expected;
    })());
    client.dispose();
    assert.equal(workers[0].terminated, true);
});

test('quantizer client cancels active and pending work', () => {
    let worker;
    const client = new AmsQuantizerClient({
        workerFactory: () => (worker = {
            postMessage() {},
            terminate() { this.terminated = true; }
        })
    });
    const job = key => ({ key, width: 1, height: 1, colorCount: 1, readImageData: () => ({ data: new Uint8ClampedArray(4) }) });
    client.submit(job('one'));
    client.submit(job('two'));
    client.cancel();

    assert.equal(client.runningKey, null);
    assert.equal(client.pendingKey, null);
    assert.equal(worker.terminated, true);
});

test('worker error and invalid result terminate the failed Worker', () => {
    for (const response of [
        { type: 'error', id: 1, message: 'quantization failed' },
        { type: 'quantized', id: 1, key: 'scene', width: 1, height: 1, colorCount: 1, pixels: new ArrayBuffer(3) }
    ]) {
        let worker;
        const errors = [];
        const client = new AmsQuantizerClient({
            workerFactory: () => (worker = {
                postMessage() {},
                terminate() { this.terminated = true; }
            }),
            onError: error => errors.push(error)
        });
        client.submit({
            key: 'scene', width: 1, height: 1, colorCount: 1,
            readImageData: () => ({ data: new Uint8ClampedArray(4) })
        });

        worker.onmessage({ data: response });
        assert.equal(worker.terminated, true, `${response.type} failures must terminate their Worker`);
        assert.equal(client.worker, null);
        assert.equal(client.available, false);
        assert.equal(client.runningKey, null);
        assert.equal(errors.length, 1);
    }
});
