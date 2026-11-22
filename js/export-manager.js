import { getTileRaster } from './image-processor.js?v=1.0.3';
import FrameGenerator from './frame-generator.js?v=1.0.3';
import { openArchiveOutput } from './archive-output.js?v=1.0.3';
import ZipWriter from './zip-writer.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';
import { parseBoundedNumber } from './project-validation.js';
import { validatePanelExport, resolveGroupCells } from './panel-groups.js';
import { getPanelGeometry, getPanelRaster, panelFilename, renderPanelCanvas } from './panel-export.js';

const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 64 * 1024 * 1024;
const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));
const numericInput = (id, fallback, min, max) => parseBoundedNumber(document.getElementById(id)?.value, fallback, min, max);

function abortError(reason) {
    if (reason instanceof Error && reason.name === 'AbortError') return reason;
    const error = new Error('The export was cancelled.');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal.reason);
}

function isArchiveLimitError(error) {
    return error instanceof RangeError && /(Archive size limit exceeded|ZIP archive exceeds|ZIP32|ZIP entry names must fit)/.test(error.message);
}

function waitWithSignal(promise, signal) {
    const pending = Promise.resolve(promise);
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolve, reject) => {
        const onAbort = () => { cleanup(); reject(abortError(signal.reason)); };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

function copyImageForSnapshot(source, width, height) {
    if (typeof createImageBitmap === 'function') return createImageBitmap(source);
    const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!canvas) return Promise.reject(new Error('Image snapshots are not supported in this browser.'));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return Promise.reject(new Error('Image snapshots are not supported in this browser.'));
    context.drawImage(source, 0, 0, width, height);
    return Promise.resolve(canvas);
}

function releaseSnapshotImage(image) {
    if (!image) return;
    if (typeof image.close === 'function') {
        try { image.close(); } catch { /* Transferred ImageBitmaps are detached on the main thread. */ }
    } else {
        // Canvas snapshots have no close() method, but releasing their backing store is explicit.
        try { image.width = 0; image.height = 0; } catch { /* Ignore non-canvas image sources. */ }
    }
}

class ExportManager {
    constructor(gridManager, imageProcessor) {
        this.gridManager = gridManager;
        this.imageProcessor = imageProcessor;
        this.busy = false;
        this.activeJob = null;
    }

    showProgress(show, text = '', pct = 0) {
        const wrapper = document.getElementById('export-progress-wrapper');
        const fill = document.getElementById('export-progress-fill');
        const txtEl = document.getElementById('export-progress-text');
        const cancelButton = document.getElementById('btn-cancel-export');
        wrapper?.classList.toggle('hidden', !show);
        cancelButton?.classList.toggle('hidden', !show);
        if (cancelButton) cancelButton.disabled = !show || Boolean(this.activeJob?.committing || this.activeJob?.cancelled);
        if (fill) fill.style.width = `${pct}%`;
        if (txtEl) txtEl.textContent = `${text} (${Math.round(pct)}%)`;
    }

    cancel() {
        const job = this.activeJob;
        if (!job || job.cancelled || job.committing) return false;
        job.cancelled = true;
        const error = abortError();
        job.controller.abort(error);
        // Keep the job busy until the writer and destination have finished aborting.
        void job.abortOutput?.(error)?.catch(() => {});
        this.showProgress(true, i18n.t('export_cancelling'));
        alert(i18n.t('export_cancelled'));
        return true;
    }

    async createSnapshot(withImages, signal, { selectCells } = {}) {
        throwIfAborted(signal);
        const grid = Object.assign(Object.create(Object.getPrototypeOf(this.gridManager)), this.gridManager, {
            config: structuredClone(this.gridManager.config),
            panelExport: structuredClone(this.gridManager.panelExport),
            cells: new Map(this.gridManager.getAllCells().map(cell => [`${cell.q},${cell.r}`, structuredClone(cell)]))
        });
        grid.invalidateGeometry();
        const images = new Map();
        const processor = Object.assign(Object.create(Object.getPrototypeOf(this.imageProcessor)), this.imageProcessor, { images });
        const sources = [];
        if (withImages) {
            let sourcePixels = 0;
            const sourceCells = selectCells ? selectCells(grid) : grid.getActiveCells();
            for (const id of new Set(sourceCells.map(cell => cell.imageId).filter(Boolean))) {
                const image = this.imageProcessor.getImage(id);
                if (!image) throw new Error(i18n.t('export_missing_image'));
                const source = this.imageProcessor.getRotatedCanvasOrImage(image);
                const width = source.width, height = source.height;
                sourcePixels += width * height;
                if (!Number.isFinite(sourcePixels) || sourcePixels > MAX_SOURCE_PIXELS) throw new Error(i18n.t('export_too_large'));
                sources.push({ id, image, source, width, height });
            }
        }
        let disposed = false;
        const dispose = () => {
            disposed = true;
            for (const image of images.values()) releaseSnapshotImage(image.imgElement);
            images.clear();
        };
        // Start copying every source before yielding. Later rotations/removals cannot change the job.
        const copyPromise = Promise.allSettled(sources.map(async ({ id, image, source, width, height }) => {
            throwIfAborted(signal);
            const bitmap = await copyImageForSnapshot(source, width, height);
            if (disposed || signal?.aborted) {
                releaseSnapshotImage(bitmap);
                throw abortError(signal?.reason);
            }
            images.set(id, { ...image, imgElement: bitmap, rotatedCanvas: null, width, height });
        }));
        let copies;
        try { copies = await waitWithSignal(copyPromise, signal); }
        catch (error) { dispose(); throw error; }
        const failure = copies.find(copy => copy.status === 'rejected');
        if (failure) { dispose(); throw failure.reason; }
        try { throwIfAborted(signal); }
        catch (error) { dispose(); throw error; }
        return { grid, processor, dispose };
    }

    async runExport({
        withImages = false, filename, progress, preflight, generate,
        captureSnapshot, selectEntries, maxBytes, limitErrorKey, signal: externalSignal
    }) {
        if (this.busy) { alert(i18n.t('export_busy')); return; }
        const job = { controller: new AbortController(), cancelled: false, committing: false, writer: null, abortOutput: null };
        const { signal } = job.controller;
        const onExternalAbort = () => {
            if (!job.committing) job.controller.abort(abortError(externalSignal.reason));
        };
        if (externalSignal?.aborted) onExternalAbort();
        else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
        this.busy = true;
        this.activeJob = job;
        let snapshot, snapshotPromise, sink, sinkPromise, writer;
        let outputClosed = false;
        let outputAborted = false;
        let abortPromise = null;
        let failureReason = abortError();
        const abortOutput = reason => {
            if (outputClosed || !sink || outputAborted) return abortPromise || Promise.resolve();
            outputAborted = true;
            failureReason = reason || failureReason;
            abortPromise = Promise.resolve().then(() => writer ? writer.abort(failureReason) : sink.abort(failureReason));
            return abortPromise;
        };
        job.abortOutput = abortOutput;
        try {
            this.showProgress(true, i18n.t(progress), 0);
            // The file picker must be invoked in the original click stack. Start snapshot
            // copying immediately afterward, before another interaction can mutate inputs.
            sinkPromise = openArchiveOutput(filename, {
                signal,
                maxBufferedBytes: MAX_EXPORT_BYTES,
                onCommitStart: () => {
                    job.committing = true;
                    const cancelButton = document.getElementById('btn-cancel-export');
                    if (cancelButton) cancelButton.disabled = true;
                }
            });
            snapshotPromise = (captureSnapshot || (snapshotSignal => this.createSnapshot(withImages, snapshotSignal)))(signal);
            [sink, snapshot] = await Promise.all([sinkPromise, snapshotPromise]);
            throwIfAborted(signal);
            if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
                throw new RangeError('Export maxBytes must be a non-negative safe integer.');
            }
            const outputMaxBytes = maxBytes === undefined ? sink.maxBytes : Math.min(sink.maxBytes, maxBytes);
            const limitKey = () => limitErrorKey || (maxBytes !== undefined && maxBytes < sink.maxBytes
                ? 'export_too_large'
                : sink.mode === 'memory' ? 'export_too_large' : 'archive_zip_limit');
            writer = new ZipWriter(sink, { signal, maxBytes: outputMaxBytes });
            job.writer = writer;
            job.abortOutput = abortOutput;
            // Report progress from the actual destination writes. Blob data is streamed by
            // ZipWriter, so only the current file size is used as a progress estimate.
            const sinkWrite = sink.write.bind(sink);
            let activeWrite = null;
            sink.write = async chunk => {
                throwIfAborted(signal);
                await sinkWrite(chunk);
                throwIfAborted(signal);
                if (activeWrite) {
                    activeWrite.written += chunk.byteLength;
                    const fraction = Math.min(1, activeWrite.written / activeWrite.expectedBytes);
                    const pct = 95 * (activeWrite.index + 0.5 + 0.5 * fraction) / activeWrite.count;
                    this.showProgress(true, i18n.t('writing_archive'), pct);
                }
            };
            const { grid, processor } = snapshot;
            const entries = selectEntries
                ? selectEntries(snapshot)
                : grid.getActiveCells().filter(cell => !withImages || cell.imageId);
            if (!entries.length) { alert(i18n.t(withImages ? 'alert_no_images' : 'alert_no_hexes')); return; }
            if (preflight) preflight(entries, grid, { mode: sink.mode, maxBytes: outputMaxBytes });
            throwIfAborted(signal);
            let bytes = 0;
            for (let index = 0; index < entries.length; index++) {
                throwIfAborted(signal);
                this.showProgress(true, i18n.t(progress), 95 * index / entries.length);
                const entry = entries[index];
                let output;
                try { output = await waitWithSignal(generate(entry, grid, processor, { signal, job }), signal); }
                catch (error) {
                    if (error?.name === 'AbortError') throw error;
                    throw new Error(entry?.label ? `${entry.label}: ${error.message}` : error.message);
                }
                throwIfAborted(signal);
                if (!output?.blob || output.blob.size === 0) {
                    throw new Error(`${entry?.label ? `${entry.label}: ` : ''}${i18n.t('export_empty_result')}`);
                }
                bytes += output.blob.size;
                if (bytes > outputMaxBytes) {
                    throw new Error(i18n.t(limitKey()));
                }
                const expectedBytes = Math.max(1, output.blob.size + 128);
                activeWrite = { index, count: entries.length, written: 0, expectedBytes };
                this.showProgress(true, i18n.t('writing_archive'), 95 * (index + 0.5) / entries.length);
                try {
                    await writer.add(output.name, output.blob);
                } catch (error) {
                    if (isArchiveLimitError(error)) {
                        throw new Error(i18n.t(limitKey()));
                    }
                    throw error;
                } finally {
                    activeWrite = null;
                    output = null;
                }
                throwIfAborted(signal);
                this.showProgress(true, i18n.t('writing_archive'), 95 * (index + 1) / entries.length);
                await waitWithSignal(yieldToUI(), signal);
            }
            throwIfAborted(signal);
            const result = await writer.close();
            outputClosed = true;
            this.showProgress(true, i18n.t('writing_archive'), 100);
            return { filename, count: result.count, bytes: result.bytes };
        } catch (error) {
            if (isArchiveLimitError(error) && sink) {
                const limitedByCaller = maxBytes !== undefined && maxBytes < sink.maxBytes;
                error = new Error(i18n.t(limitErrorKey || (limitedByCaller || sink.mode === 'memory' ? 'export_too_large' : 'archive_zip_limit')));
            }
            failureReason = error;
            if (error?.name === 'AbortError') {
                if (!signal.aborted) job.controller.abort(error);
                return;
            }
            if (!signal.aborted) job.controller.abort(error);
            console.error('Export failed:', error);
            alert(`${i18n.t('export_failed')} ${error.message}`);
        } finally {
            externalSignal?.removeEventListener('abort', onExternalAbort);
            // Promise.all can reject on either picker or snapshot failure while its sibling
            // still completes later. Await both and dispose any snapshot that arrived.
            const pending = await Promise.allSettled([sinkPromise, snapshotPromise].filter(Boolean));
            if (!sink) sink = pending.find(result => result.status === 'fulfilled' && result.value?.mode && typeof result.value?.abort === 'function')?.value;
            if (!snapshot) snapshot = pending.find(result => result.status === 'fulfilled' && typeof result.value?.dispose === 'function')?.value;
            snapshot?.dispose();
            if (sink && !outputClosed && !outputAborted) {
                try { await abortOutput(failureReason); }
                catch (error) { console.error('Could not abort export output:', error); }
            } else if (abortPromise) {
                try { await abortPromise; }
                catch (error) { console.error('Could not abort export output:', error); }
            }
            if (this.activeJob === job) {
                this.showProgress(false);
                this.activeJob = null;
                this.busy = false;
            }
        }
    }

    assertCanvasSize(cell, grid) {
        const raster = getTileRaster(cell, grid.config);
        if (!raster) throw new Error(`${cell.label}: ${i18n.t('export_empty_result')}`);
        const { width, height } = raster;
        if (width > 16384 || height > 16384 || width * height > MAX_CANVAS_PIXELS) {
            throw new Error(`${cell.label}: ${i18n.t('export_too_large')}`);
        }
    }

    async exportHexesZip() {
        return this.runExport({
            withImages: true, filename: 'hexsplitter_heksy.zip', progress: 'generating_hex_images',
            preflight: (cells, grid) => cells.forEach(cell => this.assertCanvasSize(cell, grid)),
            generate: async (cell, grid, processor) => {
                const canvas = processor.createHexagonCanvas(cell, grid);
                if (!canvas) throw new Error(i18n.t('export_empty_result'));
                const format = grid.config.exportFormat === 'jpg' ? 'jpg' : 'png';
                let output = canvas;
                try {
                    if (format === 'jpg') {
                        output = document.createElement('canvas');
                        output.width = canvas.width; output.height = canvas.height;
                        const ctx = output.getContext('2d');
                        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(canvas, 0, 0);
                    }
                    const blob = await new Promise(resolve => output.toBlob(resolve, format === 'jpg' ? 'image/jpeg' : 'image/png', grid.config.exportQuality));
                    return { name: `hex_${cell.label}.${format}`, blob };
                } finally {
                    canvas.width = 0; canvas.height = 0;
                    if (output !== canvas) { output.width = 0; output.height = 0; }
                }
            }
        });
    }

    async exportGroupsZip() {
        if (!this.gridManager.panelExport?.groups.length) {
            alert(i18n.t('alert_no_groups'));
            return;
        }
        return this.runExport({
            filename: 'hexsplitter_panels.zip', progress: 'generating_panel_images',
            captureSnapshot: signal => this.createSnapshot(true, signal, {
                selectCells: grid => {
                    try { validatePanelExport(grid.panelExport, grid.config, grid.getAllCells()); }
                    catch { throw new Error(i18n.t('export_panel_invalid')); }
                    return grid.panelExport.groups.flatMap(group => resolveGroupCells(group, grid));
                }
            }),
            selectEntries: snapshot => snapshot.grid.panelExport.groups,
            preflight: (groups, grid) => {
                for (const group of groups) {
                    const cells = resolveGroupCells(group, grid);
                    if (cells.some(cell => !cell.imageId)) throw new Error(i18n.t('export_missing_image'));
                    try { getPanelRaster(getPanelGeometry(group, grid, grid.panelExport.gapMm), grid); }
                    catch (error) {
                        throw new Error(i18n.t(error.code === 'PANEL_EXPORT_TOO_LARGE' ? 'export_too_large' : 'export_panel_invalid'));
                    }
                }
            },
            generate: async (group, grid, processor) => {
                const geometry = getPanelGeometry(group, grid, grid.panelExport.gapMm);
                const canvas = renderPanelCanvas(group, grid, processor, grid.panelExport.gapMm);
                try {
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    return { name: panelFilename(geometry), blob };
                } finally {
                    canvas.width = 0;
                    canvas.height = 0;
                }
            }
        });
    }

    async exportFrameSTL() {
        if (!document.getElementById('frame-enable').checked) { alert(i18n.t('alert_frames_disabled')); return; }
        const type = document.getElementById('frame-type').value;
        const width = numericInput('frame-width', 2, 0, 50);
        const clearance = numericInput('frame-clearance', 0.2, 0, 5);
        const height = numericInput('frame-height', 10, 1, 100);
        const base = numericInput('frame-sleeve-base', 1.2, 0.4, 20);
        return this.runExport({
            filename: `hexsplitter_ramki_${type}_stl.zip`, progress: 'generating_stl_frames',
            generate: (cell, grid) => {
                const stl = FrameGenerator.generateFrameSTL(cell, grid, type, width, clearance, height, base);
                if (!stl) throw new Error(i18n.t('export_invalid_frame'));
                return { name: `ramka_${cell.label}.stl`, blob: new Blob([stl], { type: 'application/sla' }) };
            }
        });
    }

}

export default ExportManager;
