import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ZipWriter from '../js/zip-writer.js';

function memorySink({ onWrite } = {}) {
    const chunks = [];
    const state = { closed: false, abortCalls: [], writes: 0 };
    const sink = {
        async write(bytes) {
            state.writes++;
            await onWrite?.(bytes, state.writes);
            chunks.push(bytes.slice());
        },
        async close() { state.closed = true; },
        async abort(reason) { state.abortCalls.push(reason); }
    };
    return {
        sink,
        state,
        bytes() {
            const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
            return result;
        }
    };
}

test('writes a valid UTF-8 ZIP32 with STORE entries, CRC descriptors, and empty files', async () => {
    const output = memorySink();
    const writer = new ZipWriter(output.sink);
    await writer.add('hex_Żółć.stl', new Blob([new Uint8Array([0, 1, 2, 255])]));
    await writer.add('empty.bin', new Blob([]));
    const result = await writer.close();

    assert.deepEqual(result, { bytes: output.bytes().byteLength, count: 2 });
    assert.equal(output.state.closed, true);
    assert.deepEqual(output.state.abortCalls, []);

    const archive = await JSZip.loadAsync(output.bytes(), { checkCRC32: true });
    assert.deepEqual(Object.keys(archive.files).filter(name => !archive.files[name].dir), ['hex_Żółć.stl', 'empty.bin']);
    assert.deepEqual([...await archive.file('hex_Żółć.stl').async('uint8array')], [0, 1, 2, 255]);
    assert.deepEqual([...await archive.file('empty.bin').async('uint8array')], []);
});

test('waits for sink backpressure before issuing the next write', async () => {
    let releaseFirstPayload;
    let markPayloadStarted;
    const payloadStarted = new Promise(resolve => { markPayloadStarted = resolve; });
    const payloadGate = new Promise(resolve => { releaseFirstPayload = resolve; });
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const output = memorySink({ async onWrite(_bytes, index) {
        activeWrites++;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        if (index === 3) { markPayloadStarted(); await payloadGate; }
        activeWrites--;
    } });
    const writer = new ZipWriter(output.sink);
    const addPromise = writer.add('large.bin', new Blob([new Uint8Array(256 * 1024).fill(17)]));

    await payloadStarted;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(output.state.writes, 3, 'header, filename, and one payload chunk should be pending/completed');
    assert.equal(maximumActiveWrites, 1);
    releaseFirstPayload();
    await addPromise;
    await writer.close();
    assert.equal(maximumActiveWrites, 1);
});

test('rejects entry and archive limits before writing any archive bytes', async () => {
    const tooSmall = memorySink();
    const limitedWriter = new ZipWriter(tooSmall.sink, { maxBytes: 21 });
    await assert.rejects(limitedWriter.add('a', new Blob([])), /limit/);
    assert.equal(tooSmall.state.writes, 0);
    assert.equal(tooSmall.state.closed, false);
    assert.equal(tooSmall.state.abortCalls.length, 1);

    const tooLong = memorySink();
    const longWriter = new ZipWriter(tooLong.sink);
    await assert.rejects(longWriter.add('x'.repeat(65536), new Blob([])), /65,535/);
    assert.equal(tooLong.state.writes, 0);
    assert.equal(tooLong.state.abortCalls.length, 1);

    for (const name of ['\ud800.bin', 'bad\ud800', 'bad\udc00']) {
        const malformedName = memorySink();
        const unicodeWriter = new ZipWriter(malformedName.sink);
        await assert.rejects(unicodeWriter.add(name, new Blob([])), /well-formed Unicode/);
        assert.equal(malformedName.state.writes, 0);
    }

    assert.throws(() => new ZipWriter(memorySink().sink, { maxBytes: 0xffffffff }), /maxBytes/);
    const strictLimit = memorySink();
    const strictWriter = new ZipWriter(strictLimit.sink, { maxBytes: 0xfffffffe });
    assert.deepEqual(await strictWriter.close(), { bytes: 22, count: 0 });

    let streamOpened = false;
    const sentinelSize = memorySink();
    const sizeWriter = new ZipWriter(sentinelSize.sink);
    await assert.rejects(sizeWriter.add('sentinel.bin', {
        size: 0xffffffff,
        stream() { streamOpened = true; throw new Error('must not read sentinel-sized entries'); }
    }), /below the ZIP64 sentinel/);
    assert.equal(streamOpened, false);
    assert.equal(sentinelSize.state.writes, 0);

    const archiveSentinel = memorySink();
    const archiveWriter = new ZipWriter(archiveSentinel.sink, { maxBytes: 0xfffffffe });
    await assert.rejects(archiveWriter.add('large.bin', {
        size: 0xfffffffe,
        stream() { streamOpened = true; throw new Error('preflight must reject before reading'); }
    }), /ZIP archive exceeds/);
    assert.equal(archiveSentinel.state.writes, 0);
});

test('rejects duplicate names and does not close a partial archive', async () => {
    const output = memorySink();
    const writer = new ZipWriter(output.sink);
    await writer.add('same.bin', new Blob(['first']));
    const writesBeforeDuplicate = output.state.writes;
    await assert.rejects(writer.add('same.bin', new Blob(['second'])), /Duplicate ZIP entry/);
    assert.equal(output.state.writes, writesBeforeDuplicate);
    assert.equal(output.state.closed, false);
    assert.equal(output.state.abortCalls.length, 1);
});

test('propagates sink errors and aborts the sink', async () => {
    const failure = new Error('disk full');
    const output = memorySink({ onWrite() { throw failure; } });
    const writer = new ZipWriter(output.sink);
    await assert.rejects(writer.add('file.bin', new Blob(['data'])), error => error === failure);
    assert.equal(output.state.closed, false);
    assert.deepEqual(output.state.abortCalls, [failure]);
});

test('AbortSignal interrupts an in-flight write and abort remains idempotent', async () => {
    const controller = new AbortController();
    let markPayloadStarted;
    const payloadStarted = new Promise(resolve => { markPayloadStarted = resolve; });
    let unblockWrite;
    let abortCalls = 0;
    const sink = {
        writes: 0,
        async write() {
            this.writes++;
            if (this.writes === 3) {
                markPayloadStarted();
                await new Promise(resolve => { unblockWrite = resolve; });
            }
        },
        async close() { throw new Error('cancelled writer must not close'); },
        async abort() { abortCalls++; unblockWrite?.(); }
    };
    const writer = new ZipWriter(sink, { signal: controller.signal });
    const failure = new Error('user cancelled');
    const addPromise = writer.add('file.bin', new Blob([new Uint8Array(256 * 1024)]));
    await payloadStarted;
    controller.abort(failure);
    await assert.rejects(addPromise, error => error === failure);
    await writer.abort(failure);
    assert.equal(abortCalls, 1);
    assert.equal(sink.writes, 3);
});

test('caps entry count below the ZIP64 sentinel without buffering archive bytes', async () => {
    let writeCalls = 0;
    let abortCalls = 0;
    const sink = {
        async write() { writeCalls++; },
        async close() {},
        async abort() { abortCalls++; }
    };
    const writer = new ZipWriter(sink);
    const empty = new Blob([]);
    for (let index = 0; index < 65_534; index++) await writer.add(`e${index}`, empty);
    const before = writeCalls;
    await assert.rejects(writer.add('sentinel-entry', empty), /at most 65,534 entries/);
    assert.equal(writeCalls, before, 'the sentinel entry must fail before writing');
    assert.equal(abortCalls, 1);
});
