export const BUFFERED_ARCHIVE_LIMIT = 256 * 1024 * 1024;
export const ZIP32_ARCHIVE_LIMIT = 0xfffffffe;

function abortError(reason) {
    if (reason instanceof Error) return reason;
    return new DOMException('Archive saving was cancelled.', 'AbortError');
}

function checkSignal(signal) {
    if (signal?.aborted) throw abortError(signal.reason);
}

export function waitForArchiveTask(promise, signal) {
    const pending = Promise.resolve(promise);
    if (!signal) return pending;
    if (signal.aborted) {
        void pending.catch(() => {});
        return Promise.reject(abortError(signal.reason));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => { cleanup(); reject(abortError(signal.reason)); };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(
            value => { cleanup(); resolve(value); },
            error => { cleanup(); reject(error); }
        );
    });
}

class ArchiveOutput {
    constructor({ signal, maxBytes, onCommitStart }) {
        this.signal = signal;
        this.maxBytes = maxBytes;
        this.onCommitStart = onCommitStart;
        this.bytes = 0;
        this.state = 'open';
        this.abortPromise = null;
        this.onAbort = () => { void this.abort(abortError(signal.reason)).catch(() => {}); };
        signal?.addEventListener('abort', this.onAbort, { once: true });
    }

    checkWrite(chunk) {
        checkSignal(this.signal);
        if (this.state !== 'open') throw new Error('Archive output is no longer writable.');
        if (!(chunk instanceof Uint8Array)) throw new TypeError('Expected archive bytes.');
        if (this.bytes + chunk.byteLength > this.maxBytes) {
            throw new RangeError('Archive size limit exceeded.');
        }
    }

    detachSignal() {
        this.signal?.removeEventListener('abort', this.onAbort);
    }
}

class MemoryArchiveOutput extends ArchiveOutput {
    constructor(filename, options) {
        super(options);
        this.mode = 'memory';
        this.filename = filename;
        this.chunks = [];
    }

    async write(chunk) {
        this.checkWrite(chunk);
        // The caller may reuse its chunk after write() settles.
        this.chunks.push(chunk.slice());
        this.bytes += chunk.byteLength;
    }

    async close() {
        checkSignal(this.signal);
        if (this.state !== 'open') throw new Error('Archive output cannot be closed.');
        this.state = 'closing';
        this.detachSignal();
        try {
            this.onCommitStart?.();
            const blob = new Blob(this.chunks, { type: 'application/zip' });
            globalThis.saveAs(blob, this.filename);
            this.state = 'closed';
        } finally {
            this.chunks.length = 0;
        }
    }

    async abort() {
        if (this.state === 'closed') return;
        this.state = 'aborted';
        this.detachSignal();
        this.chunks.length = 0;
    }
}

class DiskArchiveOutput extends ArchiveOutput {
    constructor(stream, options) {
        super(options);
        this.mode = 'disk';
        this.writer = typeof stream.getWriter === 'function' ? stream.getWriter() : stream;
    }

    releaseWriter() {
        try { this.writer.releaseLock?.(); } catch { /* An underlying failed stream may already be released. */ }
    }

    async write(chunk) {
        this.checkWrite(chunk);
        await this.writer.write(chunk);
        checkSignal(this.signal);
        if (this.state !== 'open') throw new Error('Archive output was interrupted.');
        this.bytes += chunk.byteLength;
    }

    async close() {
        checkSignal(this.signal);
        if (this.state !== 'open') throw new Error('Archive output cannot be closed.');
        // close() commits the browser's temporary file. Cancellation is disabled
        // at this point; claiming a rollback once close() starts would be false.
        this.state = 'closing';
        this.detachSignal();
        try {
            this.onCommitStart?.();
            await this.writer.close();
            this.state = 'closed';
        } catch (error) {
            this.state = 'failed';
            try { await this.writer.abort(error); } catch { /* Preserve the original disk error. */ }
            throw error;
        } finally {
            this.releaseWriter();
        }
    }

    abort(reason) {
        if (this.abortPromise) return this.abortPromise;
        if (this.state === 'closed' || this.state === 'closing' || this.state === 'failed') return Promise.resolve();
        this.state = 'aborted';
        this.detachSignal();
        this.abortPromise = Promise.resolve().then(() => this.writer.abort(reason)).finally(() => this.releaseWriter());
        return this.abortPromise;
    }
}

/** Opens the picker in the click's call stack, before any asynchronous work. */
export async function openArchiveOutput(filename, {
    signal, maxBufferedBytes = BUFFERED_ARCHIVE_LIMIT, onCommitStart
} = {}) {
    checkSignal(signal);
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1 || maxBufferedBytes > ZIP32_ARCHIVE_LIMIT) {
        throw new RangeError('Invalid archive size limit.');
    }
    if (typeof globalThis.showSaveFilePicker !== 'function') {
        return new MemoryArchiveOutput(filename, { signal, maxBytes: maxBufferedBytes, onCommitStart });
    }

    const extension = filename.endsWith('.hexproj') ? '.hexproj' : '.zip';
    const pickedHandle = globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: extension === '.hexproj' ? 'HexSplitter project' : 'ZIP archive', accept: { 'application/zip': [extension] } }]
    });
    const handle = await waitForArchiveTask(pickedHandle, signal);
    checkSignal(signal);
    const openingStream = Promise.resolve(handle.createWritable({ keepExistingData: false, mode: 'exclusive' }));
    let stream;
    try {
        stream = await waitForArchiveTask(openingStream, signal);
        checkSignal(signal);
    } catch (error) {
        // createWritable may finish after cancellation; discard its temporary file.
        void openingStream.then(lateStream => new DiskArchiveOutput(lateStream, {
            maxBytes: ZIP32_ARCHIVE_LIMIT
        }).abort(error)).catch(() => {});
        throw error;
    }
    return new DiskArchiveOutput(stream, { signal, maxBytes: ZIP32_ARCHIVE_LIMIT, onCommitStart });
}
