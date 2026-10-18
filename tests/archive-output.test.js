import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { openArchiveOutput } from '../js/archive-output.js';

function setup(t, picker) {
    const downloads = [];
    const values = { showSaveFilePicker: picker, saveAs: (blob, name) => downloads.push({ blob, name }) };
    const originals = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.assign(globalThis, values);
    t.after(() => originals.forEach(([key, value]) => value
        ? Object.defineProperty(globalThis, key, value) : delete globalThis[key]));
    return downloads;
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('memory fallback owns its chunks and downloads only on close', async t => {
    const downloads = setup(t);
    const output = await openArchiveOutput('test.zip', { maxBufferedBytes: 100 });
    const bytes = new Uint8Array([1, 2]);
    await output.write(bytes);
    bytes[0] = 99;
    assert.equal(output.mode, 'memory');
    assert.equal(downloads.length, 0);
    await output.close();
    assert.equal(downloads[0].name, 'test.zip');
    assert.deepEqual(new Uint8Array(await downloads[0].blob.arrayBuffer()), new Uint8Array([1, 2]));
    assert.equal(output.chunks.length, 0);
});

test('memory cap rejects additional bytes and abort discards the archive', async t => {
    const downloads = setup(t);
    const output = await openArchiveOutput('test.zip', { maxBufferedBytes: 2 });
    await output.write(new Uint8Array(2));
    await assert.rejects(output.write(new Uint8Array(1)), /size limit/);
    await output.abort();
    await assert.rejects(output.close());
    assert.equal(downloads.length, 0);
    assert.equal(output.chunks.length, 0);
});

test('picker runs synchronously and disk output uses a persistent stream writer', async t => {
    let picked = false, closed = false;
    const chunks = [];
    const stream = new WritableStream({ write: chunk => chunks.push(chunk.slice()), close: () => { closed = true; } });
    const downloads = setup(t, options => {
        picked = true;
        assert.equal(options.suggestedName, 'project.hexproj');
        assert.deepEqual(options.types[0].accept['application/zip'], ['.hexproj']);
        return Promise.resolve({ createWritable: async options => {
            assert.equal(options.keepExistingData, false);
            return stream;
        } });
    });
    const pending = openArchiveOutput('project.hexproj');
    assert.equal(picked, true);
    const output = await pending;
    assert.equal(output.mode, 'disk');
    assert.equal(stream.locked, true);
    await output.write(new Uint8Array([7]));
    assert.equal(closed, false);
    await output.close();
    assert.equal(closed, true);
    assert.equal(stream.locked, false);
    assert.equal(chunks[0][0], 7);
    assert.equal(downloads.length, 0);
});

test('aborting a slow write rolls back after the in-flight write and releases the lock', async t => {
    const gate = deferred(), started = deferred();
    let aborted = 0, closed = 0;
    const stream = new WritableStream({
        async write() { started.resolve(); await gate.promise; },
        abort() { aborted++; }, close() { closed++; }
    });
    setup(t, async () => ({ createWritable: async () => stream }));
    const controller = new AbortController();
    const output = await openArchiveOutput('test.zip', { signal: controller.signal });
    const writing = output.write(new Uint8Array([1])).then(() => null, error => error);
    await started.promise;
    controller.abort();
    gate.resolve();
    assert.equal((await writing).name, 'AbortError');
    await output.abort(controller.signal.reason);
    assert.equal(aborted, 1);
    assert.equal(closed, 0);
    assert.equal(stream.locked, false);
});

test('a writable opened after cancellation is discarded without close', async t => {
    const opening = deferred(), started = deferred();
    let aborted = 0, closed = 0;
    setup(t, async () => ({ createWritable() { started.resolve(); return opening.promise; } }));
    const controller = new AbortController();
    const pending = openArchiveOutput('test.zip', { signal: controller.signal });
    const failure = assert.rejects(pending, { name: 'AbortError' });
    await started.promise;
    controller.abort();
    await failure;
    opening.resolve(new WritableStream({ abort() { aborted++; }, close() { closed++; } }));
    await setImmediate();
    assert.equal(aborted, 1);
    assert.equal(closed, 0);
});

test('picker cancellation and permission errors never fall back to a download', async t => {
    const downloads = setup(t);
    for (const name of ['AbortError', 'NotAllowedError', 'SecurityError']) {
        globalThis.showSaveFilePicker = async () => { throw new DOMException('Picker refused', name); };
        await assert.rejects(openArchiveOutput('test.zip'), { name });
    }
    assert.equal(downloads.length, 0);
});

test('commit disables cancellation before close begins and cannot report a rollback afterward', async t => {
    const controller = new AbortController();
    let closed = 0, aborted = 0;
    setup(t, async () => ({ createWritable: async () => new WritableStream({
        close() { closed++; }, abort() { aborted++; }
    }) }));
    const output = await openArchiveOutput('test.zip', {
        signal: controller.signal, onCommitStart: () => controller.abort()
    });
    await output.close();
    await output.abort();
    assert.equal(closed, 1);
    assert.equal(aborted, 0);
});
