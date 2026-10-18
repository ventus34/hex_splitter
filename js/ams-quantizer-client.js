/** Manages one transferable AMS quantization job and one coalesced latest job. */
export default class AmsQuantizerClient {
    constructor({
        workerFactory = () => new Worker(new URL('./ams-quantizer.worker.js', import.meta.url), { type: 'module' }),
        onResult = () => {},
        onError = () => {},
        isCurrent = () => true
    } = {}) {
        this.workerFactory = workerFactory;
        this.onResult = onResult;
        this.onError = onError;
        this.isCurrent = isCurrent;
        this.worker = null;
        this.running = null;
        this.pending = null;
        this.nextId = 1;
        this.available = true;
        this.disposed = false;
    }

    get runningKey() {
        return this.running?.key ?? null;
    }

    get pendingKey() {
        return this.pending?.key ?? null;
    }

    /**
     * Submit a lazy pixel snapshot. While a task runs, only the newest scene is
     * retained; its snapshot is taken when it is actually sent to the worker.
     */
    submit(job) {
        if (this.disposed || !this.available) return false;

        if (this.running?.key === job.key) {
            this.pending = null;
            return true;
        }
        if (this.pending?.key === job.key) {
            this.pending = job;
            return true;
        }
        if (this.running) {
            this.pending = job;
            return true;
        }

        this.pending = job;
        return this.pump();
    }

    cancelPending() {
        this.pending = null;
    }

    /** Terminate in-flight CPU work and discard any coalesced scene. */
    cancel() {
        if (this.disposed) return;
        this.pending = null;
        this.running = null;
        this.worker?.terminate?.();
        this.worker = null;
        this.available = true;
    }

    dispose() {
        this.cancel();
        this.disposed = true;
    }

    pump() {
        if (this.disposed || !this.available || this.running || !this.pending) return this.available;

        const job = this.pending;
        this.pending = null;
        if (!this.isJobCurrent(job)) return true;

        try {
            if (!this.worker) {
                this.worker = this.workerFactory();
                this.worker.onmessage = event => this.handleMessage(event);
                this.worker.onerror = event => this.handleWorkerError(event);
                this.worker.onmessageerror = event => this.handleWorkerError(event);
            }

            const imageData = job.readImageData();
            if (!imageData || !imageData.data || !(imageData.data.buffer instanceof ArrayBuffer)) {
                throw new TypeError('AMS worker requires transferable ImageData');
            }
            const task = { ...job, id: this.nextId++ };
            this.running = task;
            this.worker.postMessage({
                type: 'quantize',
                id: task.id,
                key: task.key,
                width: task.width,
                height: task.height,
                colorCount: task.colorCount,
                pixels: imageData.data.buffer
            }, [imageData.data.buffer]);
            return true;
        } catch (error) {
            this.fail(error, job);
            return false;
        }
    }

    handleMessage(event) {
        const message = event?.data || {};
        const task = this.running;
        if (!task || message.id !== task.id) return;

        this.running = null;
        if (message.type === 'error') {
            this.fail(new Error(message.message || 'AMS worker failed'), task);
            return;
        }

        const validResult = message.type === 'quantized'
            && message.key === task.key
            && message.width === task.width
            && message.height === task.height
            && message.colorCount === task.colorCount
            && message.pixels instanceof ArrayBuffer
            && message.pixels.byteLength === task.width * task.height * 4;
        if (!validResult) {
            this.fail(new Error(message.message || 'AMS worker returned invalid pixel data'), task);
            return;
        }

        if (this.isJobCurrent(task)) {
            this.onResult({
                key: task.key,
                width: task.width,
                height: task.height,
                colorCount: task.colorCount,
                pixels: message.pixels
            });
        }
        this.pump();
    }

    handleWorkerError(event) {
        const task = this.running;
        if (!task) return;
        const message = event?.message || 'AMS worker could not complete the quantization task';
        this.fail(new Error(message), task);
    }

    fail(error, task) {
        this.available = false;
        this.running = null;
        this.pending = null;
        this.worker?.terminate?.();
        this.worker = null;
        this.onError(error, task);
    }

    isJobCurrent(job) {
        try {
            return this.isCurrent(job);
        } catch {
            return false;
        }
    }
}
