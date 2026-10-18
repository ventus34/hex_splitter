const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const ZIP32_MAX_VALUE = UINT32_MAX - 1;
const ZIP32_MAX_ENTRIES = UINT16_MAX - 1;
const UTF8 = new TextEncoder();
const ZIP_SIGNATURE = Object.freeze({
    local: 0x04034b50,
    descriptor: 0x08074b50,
    central: 0x02014b50,
    end: 0x06054b50
});

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[n] = value >>> 0;
    }
    return table;
})();

function crcUpdate(crc, bytes) {
    for (let index = 0; index < bytes.length; index++) {
        crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return crc >>> 0;
}

function write16(view, offset, value) {
    view.setUint16(offset, value, true);
}

function write32(view, offset, value) {
    view.setUint32(offset, value, true);
}

function fixedRecord(length, signature) {
    const bytes = new Uint8Array(length);
    write32(new DataView(bytes.buffer), 0, signature);
    return bytes;
}

function asErrorReason(reason) {
    return reason ?? new DOMException('The ZIP operation was aborted.', 'AbortError');
}

function isWellFormedUnicode(value) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
}

/**
 * Writes a ZIP32 archive with STORE entries directly to an async byte sink.
 * The sink owns the output destination; only central-directory metadata is kept
 * in memory while each Blob is copied a chunk at a time.
 */
export class ZipWriter {
    #sink;
    #signal;
    #maxBytes;
    #state = 'open';
    #bytes = 0;
    #entries = [];
    #directoryBytes = 0;
    #names = new Set();
    #reader = null;
    #busy = false;
    #abortPromise = null;
    #abortReason = null;
    #closeResult = null;
    #onSignalAbort;

    constructor(sink, { signal, maxBytes = ZIP32_MAX_VALUE } = {}) {
        if (!sink || typeof sink.write !== 'function' || typeof sink.close !== 'function' || typeof sink.abort !== 'function') {
            throw new TypeError('ZipWriter requires a sink with write(), close(), and abort() methods.');
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ZIP32_MAX_VALUE) {
            throw new RangeError('maxBytes must be an integer between 0 and 4 GiB.');
        }
        if (signal !== undefined && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
            throw new TypeError('signal must be an AbortSignal.');
        }

        this.#sink = sink;
        this.#signal = signal ?? null;
        this.#maxBytes = maxBytes;
        this.#onSignalAbort = () => { void this.abort(asErrorReason(this.#signal.reason)).catch(() => {}); };
        if (this.#signal?.aborted) this.#onSignalAbort();
        else this.#signal?.addEventListener('abort', this.#onSignalAbort, { once: true });
    }

    async add(name, blob) {
        this.#assertCanStart('add');
        this.#busy = true;
        let reader = null;
        try {
            await this.#throwIfAborted();
            const { nameBytes, size } = this.#validateEntry(name, blob);
            const localOffset = this.#uint32(this.#bytes, 'Local file offset');
            this.#preflight(nameBytes.length, size);

            const localHeader = fixedRecord(30, ZIP_SIGNATURE.local);
            const headerView = new DataView(localHeader.buffer);
            write16(headerView, 4, 20); // version needed
            write16(headerView, 6, 0x0808); // data descriptor + UTF-8 name
            write16(headerView, 8, 0); // STORE
            write16(headerView, 10, 0); // deterministic DOS time
            write16(headerView, 12, 0x0021); // 1980-01-01
            write16(headerView, 26, nameBytes.length);
            await this.#write(localHeader);
            await this.#write(nameBytes);

            reader = blob.stream().getReader();
            this.#reader = reader;
            let sizeWritten = 0;
            let crc = 0xffffffff;
            while (true) {
                await this.#throwIfAborted();
                const result = await reader.read();
                await this.#throwIfAborted();
                if (result.done) break;

                const chunk = this.#asBytes(result.value);
                if (chunk.byteLength === 0) continue;
                sizeWritten += chunk.byteLength;
                if (sizeWritten > size || sizeWritten > ZIP32_MAX_VALUE) {
                    throw new RangeError(`Entry "${name}" exceeded its declared ZIP32 size.`);
                }
                crc = crcUpdate(crc, chunk);
                await this.#write(chunk);
            }
            if (sizeWritten !== size) throw new RangeError(`Entry "${name}" did not match its declared size.`);

            const checksum = (crc ^ 0xffffffff) >>> 0;
            const descriptor = fixedRecord(16, ZIP_SIGNATURE.descriptor);
            const descriptorView = new DataView(descriptor.buffer);
            write32(descriptorView, 4, checksum);
            write32(descriptorView, 8, sizeWritten);
            write32(descriptorView, 12, sizeWritten);
            await this.#write(descriptor);

            this.#entries.push({ nameBytes, checksum, size: sizeWritten, localOffset });
            this.#directoryBytes += 46 + nameBytes.length;
            this.#names.add(name);
            return { name, bytes: sizeWritten };
        } catch (error) {
            await this.#abortAfterFailure(error);
            throw error;
        } finally {
            if (reader) {
                if (this.#reader === reader) this.#reader = null;
                try { reader.releaseLock(); } catch { /* a cancelled stream may have released the reader */ }
            }
            this.#busy = false;
        }
    }

    async close() {
        if (this.#state === 'closed') return { ...this.#closeResult };
        this.#assertCanStart('close');
        this.#busy = true;
        try {
            await this.#throwIfAborted();
            const directoryOffset = this.#uint32(this.#bytes, 'Central directory offset');
            const directorySize = this.#directoryBytes;
            this.#uint32(directorySize, 'Central directory size');
            this.#checkFinalSize(this.#bytes + directorySize + 22);

            for (const entry of this.#entries) {
                const header = fixedRecord(46, ZIP_SIGNATURE.central);
                const view = new DataView(header.buffer);
                write16(view, 4, 20); // version made by
                write16(view, 6, 20); // version needed
                write16(view, 8, 0x0808);
                write16(view, 10, 0); // STORE
                write16(view, 12, 0);
                write16(view, 14, 0x0021);
                write32(view, 16, entry.checksum);
                write32(view, 20, entry.size);
                write32(view, 24, entry.size);
                write16(view, 28, entry.nameBytes.length);
                write16(view, 30, 0); // extra length
                write16(view, 32, 0); // comment length
                write16(view, 34, 0); // disk number
                write16(view, 36, 0); // internal attributes
                write32(view, 38, 0); // external attributes
                write32(view, 42, entry.localOffset);
                await this.#write(header);
                await this.#write(entry.nameBytes);
            }

            const end = fixedRecord(22, ZIP_SIGNATURE.end);
            const endView = new DataView(end.buffer);
            write16(endView, 4, 0);
            write16(endView, 6, 0);
            write16(endView, 8, this.#entries.length);
            write16(endView, 10, this.#entries.length);
            write32(endView, 12, directorySize);
            write32(endView, 16, directoryOffset);
            write16(endView, 20, 0);
            await this.#write(end);
            await this.#throwIfAborted();
            await this.#sink.close();
            this.#state = 'closed';
            this.#removeSignalListener();
            this.#closeResult = { bytes: this.#bytes, count: this.#entries.length };
            return { ...this.#closeResult };
        } catch (error) {
            await this.#abortAfterFailure(error);
            throw error;
        } finally {
            this.#busy = false;
        }
    }

    async abort(reason) {
        if (this.#state === 'closed' || this.#state === 'aborted') return this.#abortPromise ?? undefined;
        this.#state = 'aborted';
        this.#abortReason = asErrorReason(reason);
        this.#removeSignalListener();

        const reader = this.#reader;
        this.#reader = null;
        let cancelPromise = Promise.resolve();
        try {
            if (reader) cancelPromise = Promise.resolve(reader.cancel(this.#abortReason)).catch(() => {});
        } catch { /* sink abort remains authoritative */ }
        let sinkPromise;
        try { sinkPromise = Promise.resolve(this.#sink.abort(this.#abortReason)); }
        catch (error) { sinkPromise = Promise.reject(error); }
        this.#abortPromise = Promise.allSettled([cancelPromise, sinkPromise]).then(results => {
            const sinkResult = results[1];
            if (sinkResult.status === 'rejected') throw sinkResult.reason;
        });
        return this.#abortPromise;
    }

    #validateEntry(name, blob) {
        if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
            throw new TypeError('ZIP entry names must be non-empty strings without NUL characters.');
        }
        if (!isWellFormedUnicode(name)) throw new TypeError('ZIP entry names must contain well-formed Unicode.');
        if (this.#names.has(name)) throw new Error(`Duplicate ZIP entry name: ${name}`);
        if (this.#entries.length >= ZIP32_MAX_ENTRIES) throw new RangeError('ZIP32 supports at most 65,534 entries.');
        if (!blob || typeof blob.stream !== 'function' || !Number.isSafeInteger(blob.size) || blob.size < 0) {
            throw new TypeError('Each ZIP entry must be a Blob or Blob-compatible value with stream() and a valid size.');
        }
        if (blob.size > ZIP32_MAX_VALUE) throw new RangeError('ZIP32 entry sizes must be below the ZIP64 sentinel.');

        const nameBytes = UTF8.encode(name);
        if (nameBytes.length === 0 || nameBytes.length > UINT16_MAX) {
            throw new RangeError('UTF-8 ZIP entry names must fit in 65,535 bytes.');
        }
        return { nameBytes, size: blob.size };
    }

    #preflight(nameLength, fileSize) {
        const centralSize = this.#directoryBytes + 46 + nameLength;
        const predicted = this.#bytes + 30 + nameLength + fileSize + 16 + centralSize + 22;
        this.#checkFinalSize(predicted);
        this.#uint32(this.#bytes, 'Local file offset');
        this.#uint32(centralSize, 'Central directory size');
    }

    #checkFinalSize(size) {
        if (!Number.isSafeInteger(size) || size > this.#maxBytes || size > ZIP32_MAX_VALUE) {
            throw new RangeError(`ZIP archive exceeds its ${this.#maxBytes}-byte limit.`);
        }
    }

    #uint32(value, description) {
        if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX_VALUE) {
            throw new RangeError(`${description} exceeds the ZIP32 limit.`);
        }
        return value;
    }

    #asBytes(chunk) {
        if (chunk instanceof Uint8Array) return chunk;
        if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
        throw new TypeError('Blob.stream() must yield byte arrays.');
    }

    async #write(bytes) {
        await this.#throwIfAborted();
        if (!(bytes instanceof Uint8Array)) throw new TypeError('Internal ZIP writes must use Uint8Array.');
        if (this.#bytes + bytes.byteLength > this.#maxBytes || this.#bytes + bytes.byteLength > ZIP32_MAX_VALUE) {
            throw new RangeError(`ZIP archive exceeds its ${this.#maxBytes}-byte limit.`);
        }
        if (bytes.byteLength === 0) return;
        await this.#sink.write(bytes);
        this.#bytes += bytes.byteLength;
        await this.#throwIfAborted();
    }

    async #throwIfAborted() {
        if (this.#signal?.aborted) {
            const reason = asErrorReason(this.#signal.reason);
            try { await this.abort(reason); } catch { /* preserve the signal reason */ }
            throw reason;
        }
        if (this.#state === 'aborted') throw this.#abortReason;
        if (this.#state !== 'open') throw new Error('The ZIP writer is already closed.');
    }

    #assertCanStart(operation) {
        if (this.#busy) throw new Error(`Cannot ${operation} while another ZIP operation is active.`);
        if (this.#state !== 'open') throw new Error(`Cannot ${operation} on a ${this.#state} ZIP writer.`);
    }

    async #abortAfterFailure(error) {
        try { await this.abort(error); } catch { /* preserve the original operation error */ }
    }

    #removeSignalListener() {
        this.#signal?.removeEventListener('abort', this.#onSignalAbort);
    }
}

export default ZipWriter;
