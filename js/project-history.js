const OMIT = Symbol('omit-history-value');

const OMIT_KEYS = new Set([
    'blob',
    'imageBlob',
    'fileBlob',
    'src',
    'objectUrl',
    'imgElement',
    'imageElement',
    'rotatedCanvas',
    'canvas',
    'bitmap'
]);

function isInstance(value, constructorName) {
    const Constructor = globalThis[constructorName];
    return typeof Constructor === 'function' && value instanceof Constructor;
}

function isBinaryOrMedia(value) {
    return isInstance(value, 'Blob') ||
        isInstance(value, 'ArrayBuffer') ||
        ArrayBuffer.isView(value) ||
        isInstance(value, 'ImageBitmap') ||
        isInstance(value, 'HTMLCanvasElement') ||
        isInstance(value, 'OffscreenCanvas') ||
        isInstance(value, 'HTMLImageElement') ||
        isInstance(value, 'File');
}

function cloneSnapshotValue(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        return OMIT;
    }
    if (isBinaryOrMedia(value)) return OMIT;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (typeof value !== 'object') return OMIT;
    if (ancestors.has(value)) throw new TypeError('History snapshots cannot contain circular references.');

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const result = [];
            for (const item of value) {
                const cloned = cloneSnapshotValue(item, ancestors);
                if (cloned !== OMIT) result.push(cloned);
            }
            return result;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return OMIT;
        const result = {};
        for (const key of Object.keys(value)) {
            if (OMIT_KEYS.has(key)) continue;
            const cloned = cloneSnapshotValue(value[key], ancestors);
            if (cloned !== OMIT) result[key] = cloned;
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

function cloneSnapshot(snapshot) {
    const cloned = cloneSnapshotValue(snapshot);
    if (cloned === OMIT) throw new TypeError('A history snapshot must be a JSON-like value.');
    return cloned;
}

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter(key => key !== 'savedAt').sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * Bounded in-memory undo/redo history for JSON-like project snapshots.
 *
 * Snapshots are cloned on input and output. Binary/image runtime values and
 * common blob or canvas fields are omitted so history never retains image data.
 *
 * @example
 * const history = new ProjectHistory({ maxEntries: 100, mergeWindowMs: 600 });
 * history.reset(layout);
 * history.record(nextLayout, { mergeKey: 'rotation:img-1' });
 * const previousLayout = history.undo();
 */
export default class ProjectHistory {
    constructor({ maxEntries = 100, mergeWindowMs = 600 } = {}) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new RangeError('maxEntries must be a positive integer.');
        }
        if (!Number.isFinite(mergeWindowMs) || mergeWindowMs < 0) {
            throw new RangeError('mergeWindowMs must be a non-negative finite number.');
        }
        this.maxEntries = maxEntries;
        this.mergeWindowMs = mergeWindowMs;
        this.entries = [];
        this.cursor = -1;
        this.group = null;
    }

    get size() {
        return this.entries.length;
    }

    get canUndo() {
        return this.cursor > 0;
    }

    get canRedo() {
        return this.cursor >= 0 && this.cursor < this.entries.length - 1;
    }

    get current() {
        return this.cursor < 0 ? null : cloneSnapshot(this.entries[this.cursor].snapshot);
    }

    reset(snapshot) {
        const entry = this.makeEntry(snapshot, null, Date.now());
        this.entries = [entry];
        this.cursor = 0;
        this.group = null;
        return this.current;
    }

    /**
     * Record a new state. Adjacent records with the same mergeKey are folded
     * together while they arrive within mergeWindowMs. Pass `timestamp` for a
     * deterministic clock in tests; normal callers should omit it.
     *
     * @returns {boolean} Whether the recorded current state changed.
     */
    record(snapshot, { mergeKey = null, timestamp = Date.now() } = {}) {
        if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite.');
        const entry = this.makeEntry(snapshot, mergeKey, timestamp);
        if (this.cursor < 0) {
            this.entries = [entry];
            this.cursor = 0;
            this.group = null;
            return true;
        }
        if (entry.serialized === this.entries[this.cursor].serialized) return false;

        const hadRedo = this.canRedo;
        if (hadRedo) this.entries.splice(this.cursor + 1);

        if (this.group) {
            if (this.group.hasChange) {
                this.entries[this.cursor] = entry;
                return true;
            }
            this.append(entry);
            this.group.hasChange = true;
            return true;
        }

        const currentEntry = this.entries[this.cursor];
        const elapsed = timestamp - currentEntry.timestamp;
        const canMerge = !hadRedo && mergeKey !== null &&
            currentEntry.mergeKey === mergeKey &&
            elapsed >= 0 && elapsed <= this.mergeWindowMs;
        if (canMerge) {
            this.entries[this.cursor] = entry;
            return true;
        }

        this.append(entry);
        return true;
    }

    /** Start an explicit group of edits, such as a pointer drag or rotation gesture. */
    beginGroup(key = null) {
        if (this.group) {
            if (this.group.key === key) return false;
            throw new Error('A history group is already open.');
        }
        this.group = { key, hasChange: false };
        return true;
    }

    /** Finish an explicit edit group. Further records become separate undo steps. */
    endGroup(key = undefined) {
        if (!this.group) return false;
        if (key !== undefined && key !== this.group.key) return false;
        this.group = null;
        return true;
    }

    undo() {
        this.group = null;
        if (!this.canUndo) return null;
        this.cursor--;
        return this.current;
    }

    redo() {
        this.group = null;
        if (!this.canRedo) return null;
        this.cursor++;
        return this.current;
    }

    clear() {
        this.entries = [];
        this.cursor = -1;
        this.group = null;
    }

    makeEntry(snapshot, mergeKey, timestamp) {
        const cloned = cloneSnapshot(snapshot);
        return { snapshot: cloned, serialized: stableSerialize(cloned), mergeKey, timestamp };
    }

    append(entry) {
        this.entries.push(entry);
        this.cursor = this.entries.length - 1;
        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
            this.cursor--;
        }
    }
}
