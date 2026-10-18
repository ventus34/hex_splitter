import { PROJECT_LAYOUT_RECORD_ID } from './project-validation.js';

export default class ProjectStore {
    static DB_NAME = 'HexSplitterImagesDB';
    static DB_VERSION = 1;
    static STORE_NAME = 'images';
    static databasePromise = null;
    static writeGuard = null;
    static pendingWrites = new Set();

    static setWriteGuard(guard) {
        this.writeGuard = guard;
    }

    static open() {
        if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB jest niedostępne.'));
        if (this.databasePromise) return this.databasePromise;

        this.databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = event => {
                const db = event.target.result;
                db.onversionchange = () => {
                    db.close();
                    this.databasePromise = null;
                };
                resolve(db);
            };
            request.onerror = () => {
                this.databasePromise = null;
                reject(request.error || new Error('Nie udało się otworzyć lokalnej bazy projektu.'));
            };
            request.onblocked = () => {
                // Keep waiting: an earlier app tab may still be finishing an upgrade.
            };
        });
        return this.databasePromise;
    }

    static close() {
        if (!this.databasePromise) return;
        const current = this.databasePromise;
        this.databasePromise = null;
        current.then(db => db.close()).catch(() => {});
    }

    static async transaction(mode, operation, { skipWriteGuard = false } = {}) {
        const db = await this.open();
        if (mode === 'readwrite' && !skipWriteGuard && this.writeGuard && !this.writeGuard.canStartWrite()) {
            throw new Error('Ten projekt jest tylko do odczytu w tej karcie.');
        }

        const transactionPromise = new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, mode);
            const store = tx.objectStore(this.STORE_NAME);
            let result;
            let operationError = null;
            const runOperation = () => {
                try {
                    result = operation(store, tx);
                } catch (error) {
                    operationError = error;
                    try { tx.abort(); } catch {}
                }
            };
            if (mode === 'readwrite' && !skipWriteGuard && this.writeGuard) {
                try {
                    this.writeGuard.authorizeTransaction(store, tx, runOperation, error => {
                        operationError = error;
                        try { tx.abort(); } catch {}
                    });
                } catch (error) {
                    operationError = error;
                    try { tx.abort(); } catch {}
                }
            } else {
                runOperation();
            }
            tx.oncomplete = () => operationError ? reject(operationError) : resolve(result);
            tx.onabort = () => reject(operationError || tx.error || new Error('Zapis projektu został przerwany.'));
            tx.onerror = () => {};
        });
        if (mode !== 'readwrite') return transactionPromise;

        let trackedWrite;
        trackedWrite = transactionPromise.finally(() => this.pendingWrites.delete(trackedWrite));
        this.pendingWrites.add(trackedWrite);
        return trackedWrite;
    }

    static async waitForPendingWrites() {
        while (this.pendingWrites.size > 0) {
            await Promise.allSettled([...this.pendingWrites]);
        }
    }

    static save(id, name, blob, width, height) {
        return this.transaction('readwrite', store => {
            store.put({ id, name, blob, width, height, rotation: 0, zoom: 1 });
        });
    }

    static updateField(id, field, value) {
        return this.transaction('readwrite', store => {
            const request = store.get(id);
            request.onsuccess = () => {
                if (!request.result) return;
                store.put({ ...request.result, [field]: value });
            };
        });
    }

    static updateRotation(id, rotation) {
        return this.updateField(id, 'rotation', rotation);
    }

    static updateZoom(id, zoom) {
        return this.updateField(id, 'zoom', zoom);
    }

    static delete(id) {
        return this.transaction('readwrite', store => store.delete(id));
    }

    static async getAll() {
        return this.transaction('readonly', store => store.getAll())
            .then(request => request.result.filter(record => record.id !== PROJECT_LAYOUT_RECORD_ID));
    }

    static async getProjectSnapshot() {
        const snapshot = await this.transaction('readonly', store => ({
            images: store.getAll(),
            metadata: store.get(PROJECT_LAYOUT_RECORD_ID)
        }));
        return {
            images: snapshot.images.result.filter(record => record.id !== PROJECT_LAYOUT_RECORD_ID),
            layout: snapshot.metadata.result?.layout ?? null
        };
    }

    static async getLayout() {
        return this.transaction('readonly', store => store.get(PROJECT_LAYOUT_RECORD_ID))
            .then(request => request?.result?.layout ?? null);
    }

    static saveLayout(layout) {
        return this.transaction('readwrite', store => {
            const request = store.get(PROJECT_LAYOUT_RECORD_ID);
            request.onsuccess = () => store.put({ ...(request.result || {}), id: PROJECT_LAYOUT_RECORD_ID, layout });
        });
    }

    static saveHistoryState(layout, transforms = []) {
        return this.transaction('readwrite', store => {
            const layoutRequest = store.get(PROJECT_LAYOUT_RECORD_ID);
            layoutRequest.onsuccess = () => store.put({ ...(layoutRequest.result || {}), id: PROJECT_LAYOUT_RECORD_ID, layout });
            for (const transform of transforms) {
                const imageRequest = store.get(transform.id);
                imageRequest.onsuccess = () => {
                    if (!imageRequest.result) return;
                    store.put({
                        ...imageRequest.result,
                        ...(transform.rotation !== undefined ? { rotation: transform.rotation } : {}),
                        ...(transform.zoom !== undefined ? { zoom: transform.zoom } : {})
                    });
                };
            }
        });
    }

    static clearLayout() {
        return this.transaction('readwrite', store => {
            const request = store.get(PROJECT_LAYOUT_RECORD_ID);
            request.onsuccess = () => {
                const record = request.result;
                if (record?.sessionLease) {
                    delete record.layout;
                    store.put(record);
                } else {
                    store.delete(PROJECT_LAYOUT_RECORD_ID);
                }
            };
        });
    }

    static replaceProject(images, layout) {
        return this.transaction('readwrite', store => {
            const metadataRequest = store.get(PROJECT_LAYOUT_RECORD_ID);
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
                const metadata = metadataRequest.result || { id: PROJECT_LAYOUT_RECORD_ID };
                for (const key of keysRequest.result) {
                    if (key !== PROJECT_LAYOUT_RECORD_ID) store.delete(key);
                }
                for (const image of images) {
                    store.put({
                        id: image.id,
                        name: image.name,
                        blob: image.blob,
                        width: image.width,
                        height: image.height,
                        rotation: image.rotation,
                        zoom: image.zoom
                    });
                }
                store.put({ ...metadata, id: PROJECT_LAYOUT_RECORD_ID, layout });
            };
        });
    }

    static clear() {
        return this.transaction('readwrite', store => {
            const metadataRequest = store.get(PROJECT_LAYOUT_RECORD_ID);
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
                for (const key of keysRequest.result) {
                    if (key !== PROJECT_LAYOUT_RECORD_ID) store.delete(key);
                }
                const metadata = metadataRequest.result;
                if (metadata?.sessionLease) {
                    delete metadata.layout;
                    store.put(metadata);
                } else {
                    store.delete(PROJECT_LAYOUT_RECORD_ID);
                }
            };
        });
    }

    static async getSessionLease() {
        return this.transaction('readonly', store => store.get(PROJECT_LAYOUT_RECORD_ID))
            .then(request => request?.result?.sessionLease ?? null);
    }

    static claimSessionLease({ ownerId, token, expiresAt, force = false }) {
        let acquired = false;
        return this.transaction('readwrite', store => {
            const request = store.get(PROJECT_LAYOUT_RECORD_ID);
            request.onsuccess = () => {
                const record = request.result || { id: PROJECT_LAYOUT_RECORD_ID };
                const lease = record.sessionLease;
                if (force || !lease || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) {
                    store.put({ ...record, id: PROJECT_LAYOUT_RECORD_ID, sessionLease: { ownerId, token, expiresAt } });
                    acquired = true;
                }
            };
        }, { skipWriteGuard: true }).then(() => acquired);
    }

    static renewSessionLease({ ownerId, token, expiresAt, allowExpired = false }) {
        let renewed = false;
        return this.transaction('readwrite', store => {
            const request = store.get(PROJECT_LAYOUT_RECORD_ID);
            request.onsuccess = () => {
                const record = request.result;
                const lease = record?.sessionLease;
                if (lease?.ownerId === ownerId && lease.token === token && (allowExpired || lease.expiresAt > Date.now())) {
                    store.put({ ...record, sessionLease: { ...lease, expiresAt } });
                    renewed = true;
                }
            };
        }, { skipWriteGuard: true }).then(() => renewed);
    }

    static releaseSessionLease({ ownerId, token }) {
        let released = false;
        return this.transaction('readwrite', store => {
            const request = store.get(PROJECT_LAYOUT_RECORD_ID);
            request.onsuccess = () => {
                const record = request.result;
                if (record?.sessionLease?.ownerId !== ownerId || record.sessionLease.token !== token) return;
                delete record.sessionLease;
                if (record.layout) store.put(record);
                else store.delete(PROJECT_LAYOUT_RECORD_ID);
                released = true;
            };
        }, { skipWriteGuard: true }).then(() => released);
    }
}
