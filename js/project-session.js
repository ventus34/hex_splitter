import { PROJECT_LAYOUT_RECORD_ID } from './project-validation.js';

const LEASE_DURATION_MS = 20_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const TAKEOVER_POLL_MS = 250;

function makeId() {
    return globalThis.crypto?.randomUUID?.() || `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Coordinates one editing tab per origin and fences every persistent write by lease token. */
export default class ProjectSession {
    constructor({ store, onStatusChange = () => {}, beforeRelease = async () => {}, beforeSuspend = async () => {}, documentRef = globalThis.document, navigatorRef = globalThis.navigator, origin = globalThis.location?.origin || 'local' }) {
        if (!store) throw new TypeError('ProjectSession requires a project store.');
        this.store = store;
        this.onStatusChange = onStatusChange;
        this.beforeRelease = beforeRelease;
        this.beforeSuspend = beforeSuspend;
        this.document = documentRef;
        this.navigator = navigatorRef;
        this.tabId = makeId();
        this.token = makeId();
        this.state = 'starting';
        this._ownsLease = false;
        this._webLockHeld = false;
        this._releaseWebLock = null;
        this._heartbeat = null;
        this._channel = null;
        this._releasePromise = null;
        this._takeoverPromise = null;
        this._takeoverCanceled = false;
        this._lockAbortController = null;
        this._leaseExpiresAt = 0;
        this._releaseFlushOpen = false;
        this._closed = false;
        this._onVisibilityChange = () => this.#handleVisibilityChange();
        this._lockName = `${origin}:HexSplitterImagesDB:project-edit`;
        this._channelName = `${origin}:HexSplitterImagesDB:project-session`;
        this._usesWebLocks = typeof this.navigator?.locks?.request === 'function';
    }

    get isOwner() {
        return this._ownsLease && this.state === 'owner' && this.document?.visibilityState !== 'hidden';
    }

    get canWrite() {
        return this._ownsLease && (
            (this.state === 'owner' && this.document?.visibilityState !== 'hidden') ||
            ((this.state === 'suspending' || this.state === 'releasing') && this._releaseFlushOpen)
        );
    }

    canStartWrite() {
        return this.canWrite;
    }

    async start() {
        this.document?.addEventListener('visibilitychange', this._onVisibilityChange);
        try {
            if (typeof globalThis.BroadcastChannel === 'function') {
                try {
                    this._channel = new BroadcastChannel(this._channelName);
                    this._channel.onmessage = event => this.#handleMessage(event.data);
                } catch (error) {
                    console.warn('Powiadamianie innych kart jest niedostępne; synchronizacja nadal chroni zapisy.', error);
                }
            }
            if (this._usesWebLocks) {
                const acquired = await this.#requestWebLock(false);
                if (!acquired) await this.#setReadOnly(await this.store.getSessionLease().catch(() => null));
            } else {
                const acquired = await this.store.claimSessionLease({
                    ownerId: this.tabId,
                    token: this.token,
                    expiresAt: Date.now() + LEASE_DURATION_MS
                });
                if (acquired) this.#becomeOwner('startup');
                else await this.#setReadOnly(await this.store.getSessionLease().catch(() => null));
            }
        } catch (error) {
            console.error('Nie udało się ustalić właściciela projektu.', error);
            this.#setState('unavailable', null);
        }
        return this.state;
    }

    async takeOver() {
        if (this.isOwner) return true;
        if (this._takeoverPromise) return this._takeoverPromise;
        this._takeoverPromise = this.#takeOverImpl();
        try {
            return await this._takeoverPromise;
        } finally {
            this._takeoverPromise = null;
        }
    }

    async #takeOverImpl() {
        this._takeoverCanceled = false;
        this.#setState('taking-over', this._knownOwner || null);
        this.#post({ type: 'takeover-request', requester: this.tabId });
        try {
            if (this._usesWebLocks) {
                const acquired = await this.#requestWebLock(true);
                if (!acquired) await this.#setReadOnly(await this.store.getSessionLease().catch(() => null));
                return acquired;
            }
            while (!this._closed && !this._takeoverCanceled) {
                const acquired = await this.store.claimSessionLease({
                    ownerId: this.tabId,
                    token: this.token,
                    expiresAt: Date.now() + LEASE_DURATION_MS
                });
                if (acquired) {
                    this.#becomeOwner('takeover');
                    return true;
                }
                const lease = await this.store.getSessionLease().catch(() => null);
                if (lease?.ownerId !== this._knownOwner) this._knownOwner = lease?.ownerId || null;
                this.#setState('taking-over', lease);
                await wait(TAKEOVER_POLL_MS);
            }
            if (!this._closed && this._takeoverCanceled) {
                await this.#setReadOnly(await this.store.getSessionLease().catch(() => null));
            }
            return false;
        } catch (error) {
            console.error('Nie udało się przejąć edycji projektu.', error);
            await this.#setReadOnly(await this.store.getSessionLease().catch(() => null));
            return false;
        }
    }

    async #requestWebLock(waitForOwner) {
        let acquiredResolve;
        let acquiredSettled = false;
        const acquiredPromise = new Promise(resolve => { acquiredResolve = resolve; });
        const settleAcquired = value => {
            if (acquiredSettled) return;
            acquiredSettled = true;
            acquiredResolve(value);
        };
        const options = { mode: 'exclusive' };
        if (!waitForOwner) options.ifAvailable = true;
        else {
            this._lockAbortController = new AbortController();
            options.signal = this._lockAbortController.signal;
        }
        let request;
        try {
            request = this.navigator.locks.request(this._lockName, options, async lock => {
                if (!lock) {
                    settleAcquired(false);
                    return;
                }
                if (this._closed) {
                    settleAcquired(false);
                    return;
                }
                this._webLockHeld = true;
                try {
                    const claimed = await this.store.claimSessionLease({
                        ownerId: this.tabId,
                        token: this.token,
                        expiresAt: Date.now() + LEASE_DURATION_MS,
                        force: true
                    });
                    if (!claimed) throw new Error('Nie udało się zapisać dzierżawy projektu.');
                    if (this._closed) {
                        await this.store.releaseSessionLease({ ownerId: this.tabId, token: this.token });
                        settleAcquired(false);
                        return;
                    }
                    this.#becomeOwner(waitForOwner ? 'takeover' : 'startup');
                    settleAcquired(true);
                    await new Promise(resolve => { this._releaseWebLock = resolve; });
                } catch (error) {
                    this._webLockHeld = false;
                    settleAcquired(false);
                    throw error;
                } finally {
                    this._webLockHeld = false;
                    this._releaseWebLock = null;
                }
            });
            request.catch(error => {
                if (!acquiredSettled) settleAcquired(false);
                if (error?.name !== 'AbortError') console.error('Web Lock projektu zakończył się błędem.', error);
            });
        } catch (error) {
            settleAcquired(false);
            console.error('Web Locks API nie jest dostępne dla projektu.', error);
        }
        return acquiredPromise;
    }

    async release(reason = 'release') {
        if (!this._ownsLease) return;
        if (this._releasePromise) return this._releasePromise;
        this._releasePromise = this.#releaseImpl(reason);
        try {
            await this._releasePromise;
        } finally {
            this._releasePromise = null;
        }
    }

    async #releaseImpl(reason) {
        this.#setState('releasing', null);
        this._releaseFlushOpen = true;
        try {
            const flushed = await this.beforeRelease();
            if (flushed === false) {
                this._releaseFlushOpen = false;
                this.#setState('owner', { ownerId: this.tabId });
                if (reason === 'takeover-request') this.#post({ type: 'takeover-deferred', ownerId: this.tabId });
                return false;
            }
        } catch (error) {
            console.error('Nie udało się zapisać zmian przed zwolnieniem projektu.', error);
            this._releaseFlushOpen = false;
            this.#setState('owner', { ownerId: this.tabId });
            if (reason === 'takeover-request') this.#post({ type: 'takeover-deferred', ownerId: this.tabId });
            return false;
        }
        this._releaseFlushOpen = false;
        await this.store.waitForPendingWrites?.();
        try {
            await this.store.releaseSessionLease({ ownerId: this.tabId, token: this.token });
        } catch (error) {
            console.error('Nie udało się zwolnić dzierżawy projektu.', error);
        }
        this.#stopHeartbeat();
        this._ownsLease = false;
        this.#setState('readonly', null);
        this.#post({ type: 'released', ownerId: this.tabId, reason });
        if (this._releaseWebLock) this._releaseWebLock();
    }

    async close() {
        this._closed = true;
        this._takeoverCanceled = true;
        this._lockAbortController?.abort();
        if (this._takeoverPromise) await this._takeoverPromise.catch(() => {});
        await this.release('close');
        this.document?.removeEventListener('visibilitychange', this._onVisibilityChange);
        if (this._channel) {
            this._channel.close();
            this._channel = null;
        }
    }

    authorizeTransaction(store, _tx, runOperation, reject) {
        if (!this._ownsLease || !this.canWrite) {
            reject(new Error('Ta karta nie ma już prawa zapisywać projektu.'));
            return;
        }
        const request = store.get(PROJECT_LAYOUT_RECORD_ID);
        request.onerror = () => {
            this.#loseOwnership(null);
            reject(request.error || new Error('Nie można sprawdzić właściciela projektu.'));
        };
        request.onsuccess = () => {
            const record = request.result;
            const lease = record?.sessionLease;
            const matches = lease?.ownerId === this.tabId && lease.token === this.token;
            const active = lease?.expiresAt > Date.now() || this._webLockHeld;
            if (!matches || !active) {
                this.#loseOwnership(lease || null);
                reject(new Error('Ta karta utraciła prawo do zapisu projektu.'));
                return;
            }
            const expiresAt = Date.now() + LEASE_DURATION_MS;
            store.put({ ...record, sessionLease: { ...lease, expiresAt } });
            this._leaseExpiresAt = expiresAt;
            runOperation();
        };
    }

    async #handleVisibilityChange() {
        if (this.document?.visibilityState === 'hidden') {
            if (!this._ownsLease || this.state !== 'owner') return;
            this.#setState('suspending', null);
            this._releaseFlushOpen = true;
            try { await this.beforeSuspend(); }
            catch (error) { console.error('Nie udało się zapisać projektu przed ukryciem karty.', error); }
            this._releaseFlushOpen = false;
            await this.store.waitForPendingWrites?.();
            if (this._ownsLease && this.state === 'suspending') this.#setState('suspended', null);
            return;
        }
        if (this.document?.visibilityState === 'visible' && this._ownsLease) {
            await this.#refreshOwnership();
        }
    }

    async #refreshOwnership() {
        try {
            const lease = await this.store.getSessionLease();
            if (lease?.ownerId !== this.tabId || lease.token !== this.token || (!this._webLockHeld && lease.expiresAt <= Date.now())) {
                this.#loseOwnership(lease || null);
                return false;
            }
            const renewed = await this.store.renewSessionLease({
                ownerId: this.tabId,
                token: this.token,
                expiresAt: Date.now() + LEASE_DURATION_MS,
                allowExpired: this._webLockHeld
            });
            if (!renewed) {
                this.#loseOwnership(await this.store.getSessionLease().catch(() => null));
                return false;
            }
            this._leaseExpiresAt = Date.now() + LEASE_DURATION_MS;
            this.#setState('owner', null);
            this.#post({ type: 'owner', ownerId: this.tabId, expiresAt: this._leaseExpiresAt });
            return true;
        } catch (error) {
            console.error('Nie udało się ponownie sprawdzić dzierżawy projektu.', error);
            this.#loseOwnership(null);
            return false;
        }
    }

    async #heartbeat() {
        if (!this._ownsLease || this.state !== 'owner') return;
        try {
            const renewed = await this.store.renewSessionLease({
                ownerId: this.tabId,
                token: this.token,
                expiresAt: Date.now() + LEASE_DURATION_MS,
                allowExpired: false
            });
            if (!renewed) {
                this.#loseOwnership(await this.store.getSessionLease().catch(() => null));
                return;
            }
            this._leaseExpiresAt = Date.now() + LEASE_DURATION_MS;
            this.#post({ type: 'owner', ownerId: this.tabId, expiresAt: this._leaseExpiresAt });
        } catch (error) {
            console.warn('Nie udało się odnowić dzierżawy projektu.', error);
            this.#loseOwnership(null);
        }
    }

    async #handleMessage(message) {
        if (!message || message.ownerId === this.tabId || message.requester === this.tabId) return;
        if (message.type === 'takeover-request' && this._ownsLease) {
            await this.release('takeover-request');
        } else if (message.type === 'owner' && !this._ownsLease) {
            this._knownOwner = message.ownerId;
            if (this.state === 'readonly') this.#setState('readonly', message);
        } else if (message.type === 'released' && !this._ownsLease && this.state === 'readonly') {
            this._knownOwner = null;
            this.#setState('readonly', null);
        } else if (message.type === 'takeover-deferred' && !this._ownsLease && this.state === 'taking-over') {
            this._takeoverCanceled = true;
            this._lockAbortController?.abort();
        }
    }

    async #setReadOnly(lease) {
        this._knownOwner = lease?.ownerId || this._knownOwner || null;
        this._ownsLease = false;
        this.#stopHeartbeat();
        this.#setState('readonly', lease);
    }

    #becomeOwner(reason) {
        this._ownsLease = true;
        this._leaseExpiresAt = Date.now() + LEASE_DURATION_MS;
        this.#setState('owner', { ownerId: this.tabId, reason });
        this.#startHeartbeat();
        this.#post({ type: 'owner', ownerId: this.tabId, expiresAt: this._leaseExpiresAt });
    }

    #loseOwnership(lease) {
        this._ownsLease = false;
        this._knownOwner = lease?.ownerId || null;
        this.#stopHeartbeat();
        this.#setState('readonly', lease);
        this.#post({ type: 'owner', ownerId: this._knownOwner, expiresAt: lease?.expiresAt || 0 });
        if (this._releaseWebLock) this._releaseWebLock();
    }

    #setState(state, lease) {
        this.state = state;
        if (lease?.ownerId) this._knownOwner = lease.ownerId;
        const status = {
            state,
            isOwner: this.isOwner,
            canWrite: this.canWrite,
            ownerTabId: lease?.ownerId || this._knownOwner || null,
            expiresAt: lease?.expiresAt || this._leaseExpiresAt,
            method: this._usesWebLocks ? 'web-locks' : 'indexeddb-lease'
        };
        this.onStatusChange(status);
        if (typeof this.document?.dispatchEvent === 'function') {
            const EventConstructor = this.document.defaultView?.CustomEvent || globalThis.CustomEvent;
            if (EventConstructor) this.document.dispatchEvent(new EventConstructor('projectsessionchange', { detail: status }));
        }
    }

    #startHeartbeat() {
        this.#stopHeartbeat();
        this._heartbeat = setInterval(() => this.#heartbeat(), HEARTBEAT_INTERVAL_MS);
    }

    #stopHeartbeat() {
        if (this._heartbeat !== null) clearInterval(this._heartbeat);
        this._heartbeat = null;
    }

    #post(message) {
        try { this._channel?.postMessage({ ...message, sender: this.tabId }); }
        catch (error) { console.warn('Nie udało się powiadomić innych kart o stanie projektu.', error); }
    }
}
