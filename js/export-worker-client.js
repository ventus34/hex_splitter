function makeAbortError(reason) {
    if (reason instanceof Error && reason.name === 'AbortError') return reason;
    const error = new Error('The export was cancelled.');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw makeAbortError(signal.reason);
}

/** Main-thread client for one relief export. Bitmaps are transferred once per job. */
export default class ExportWorkerClient {
    static isSupported() {
        return typeof Worker === 'function' &&
            typeof OffscreenCanvas === 'function' &&
            typeof createImageBitmap === 'function';
    }

    constructor({ workerFactory } = {}) {
        this.workerFactory = workerFactory || (() => new Worker(
            new URL('./export-worker.js', import.meta.url),
            { type: 'module' }
        ));
        this.worker = null;
        this.pending = new Map();
        this.nextRequestId = 1;
        this.ready = false;
        this.closed = false;
    }

    async initialize(processor, { signal } = {}) {
        if (this.ready) return;
        if (this.closed) throw makeAbortError();
        throwIfAborted(signal);

        const entries = [...processor.images.entries()].map(([id, image]) => ({ id, bitmap: image.imgElement }));
        if (entries.some(entry => !entry.bitmap || typeof entry.bitmap.close !== 'function')) {
            throw new Error('The source image cannot be transferred to the export worker.');
        }

        const worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = event => this.handleMessage(event.data || {});
        worker.onerror = event => {
            event.preventDefault?.();
            this.failAll(new Error(event.message || 'The export worker failed.'));
            this.terminate();
        };

        await new Promise((resolve, reject) => {
            const onAbort = () => {
                cleanup();
                this.terminate();
                reject(makeAbortError(signal.reason));
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            this.resolveReady = () => { cleanup(); resolve(); };
            this.rejectReady = error => { cleanup(); reject(error); };
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                worker.postMessage({ type: 'init', images: entries }, entries.map(entry => entry.bitmap));
            } catch (error) {
                cleanup();
                this.rejectReady = null;
                this.resolveReady = null;
                this.terminate();
                reject(error);
            }
        });
        this.ready = true;
    }

    handleMessage(message) {
        if (message.type === 'ready') {
            this.resolveReady?.();
            this.resolveReady = null;
            this.rejectReady = null;
            return;
        }
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        pending.cleanup();
        if (message.type === 'result' && message.buffer instanceof ArrayBuffer) pending.resolve(message.buffer);
        else pending.reject(new Error(message.message || 'The export worker returned an invalid result.'));
    }

    failAll(error) {
        this.rejectReady?.(error);
        this.rejectReady = null;
        this.resolveReady = null;
        for (const pending of this.pending.values()) {
            pending.cleanup();
            pending.reject(error);
        }
        this.pending.clear();
    }

    generate(cell, gridConfig, options, { signal } = {}) {
        throwIfAborted(signal);
        if (!this.ready || !this.worker || this.closed) return Promise.reject(new Error('The export worker is not ready.'));
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.pending.delete(requestId);
                cleanup();
                reject(makeAbortError(signal.reason));
                this.terminate();
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pending.set(requestId, { resolve, reject, cleanup });
            try {
                this.worker.postMessage({ type: 'generate', requestId, cell, gridConfig, options });
            } catch (error) {
                this.pending.delete(requestId);
                cleanup();
                reject(error);
            }
        });
    }

    terminate(reason = makeAbortError()) {
        if (this.closed) return;
        this.closed = true;
        this.failAll(reason);
        this.worker?.terminate();
        this.worker = null;
    }
}

export { makeAbortError };
