import HexMath from './hex-math.js?v=1.0.3';
import FrameGenerator from './frame-generator.js?v=1.0.3';
import STLHexGenerator from './stl-hex-generator.js?v=1.0.3';
import ExportWorkerClient from './export-worker-client.js?v=1.0.3';
import { openArchiveOutput } from './archive-output.js?v=1.0.3';
import ZipWriter from './zip-writer.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';
import { parseBoundedNumber } from './project-validation.js';

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
        job.workerClient?.terminate(error);
        // Keep the job busy until the writer and destination have finished aborting.
        void job.abortOutput?.(error)?.catch(() => {});
        this.showProgress(false);
        alert(i18n.t('export_cancelled'));
        return true;
    }

    async createSnapshot(withImages, signal) {
        throwIfAborted(signal);
        const grid = Object.assign(Object.create(Object.getPrototypeOf(this.gridManager)), this.gridManager, {
            config: structuredClone(this.gridManager.config),
            cells: new Map(this.gridManager.getAllCells().map(cell => [`${cell.q},${cell.r}`, structuredClone(cell)]))
        });
        const images = new Map();
        const processor = Object.assign(Object.create(Object.getPrototypeOf(this.imageProcessor)), this.imageProcessor, { images });
        const sources = [];
        if (withImages) {
            let sourcePixels = 0;
            for (const id of new Set(grid.getActiveCells().map(cell => cell.imageId).filter(Boolean))) {
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
        withImages = false, filename, progress, preflight, prepare, generate,
        captureSnapshot, selectEntries, maxBytes, limitErrorKey, signal: externalSignal
    }) {
        if (this.busy) { alert(i18n.t('export_busy')); return; }
        const job = { controller: new AbortController(), cancelled: false, committing: false, workerClient: null, writer: null, abortOutput: null };
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
            if (prepare) await prepare(grid, processor, { signal, job });
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
            job.workerClient?.terminate();
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
        const vertices = HexMath.getCellVertices(cell, grid.config);
        const width = Math.max(...vertices.map(v => v.x)) - Math.min(...vertices.map(v => v.x));
        const height = Math.max(...vertices.map(v => v.y)) - Math.min(...vertices.map(v => v.y));
        const dimensions = HexMath.getHexDimensions(grid.config.hexSize, grid.config.orientation);
        const scale = grid.config.dpi === 'original' && cell.cropRegion
            ? cell.cropRegion.w / dimensions.width : HexMath.mmToPixels(1, grid.config.dpi === 'original' ? 300 : grid.config.dpi);
        const w = Math.round(width * scale), h = Math.round(height * scale);
        if (!Number.isFinite(w * h) || w <= 0 || h <= 0 || w > 16384 || h > 16384 || w * h > MAX_CANVAS_PIXELS)
            throw new Error(`${cell.label}: ${i18n.t('export_too_large')}`);
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

    async exportFrameSTL() {
        if (!document.getElementById('frame-enable').checked) { alert(i18n.t('alert_frames_disabled')); return; }
        const type = document.getElementById('frame-type').value;
        const width = numericInput('frame-width', 2, 0, 50);
        const clearance = numericInput('frame-clearance', 0.2, 0, 5);
        const height = numericInput('frame-height', 10, 1, 100);
        const base = numericInput('frame-sleeve-base', 1.2, 0.4, 20);
        return this.runExport({
            filename: `hexsplitter_ramki_${type}_stl.zip`, progress: 'generating_stl_frames',
            generate: (cell, grid) => ({ name: `ramka_${cell.label}.stl`, blob: new Blob([
                FrameGenerator.generateFrameSTL(cell, grid, type, width, clearance, height, base)
            ], { type: 'application/sla' }) })
        });
    }

    async exportHexes3DStl(options = {}) {
        const settings = {
            ...options,
            sectors: Math.round(parseBoundedNumber(options.sectors, 120, 30, 360)),
            rings: Math.round(parseBoundedNumber(options.rings, 60, 15, 180)),
            reliefHeight: parseBoundedNumber(options.reliefHeight, 2, 0.1, 50),
            baseThickness: parseBoundedNumber(options.baseThickness, 1.2, 0.4, 50),
            blur: parseBoundedNumber(options.blur, 1.5, 0, 5),
        };
        return this.runExport({
            withImages: true, filename: 'hexsplitter_heksy_3d_stl.zip', progress: 'generating_3d_hex_stl',
            preflight: (cells, _grid, sink) => {
                // Include up to six extra sectors for exact polygon corners.
                const upperBound = cells.length * (84 + 2 * (settings.sectors + 6) * (settings.rings + 1) * 50);
                if (upperBound > sink.maxBytes) {
                    throw new Error(i18n.t(sink.mode === 'memory' ? 'export_too_large' : 'archive_zip_limit'));
                }
            },
            prepare: async (grid, processor, { signal, job }) => {
                if (!ExportWorkerClient.isSupported()) return;
                const workerClient = new ExportWorkerClient();
                job.workerClient = workerClient;
                await workerClient.initialize(processor, { signal });
            },
            generate: async (cell, grid, processor, { signal, job }) => {
                const buffer = job.workerClient
                    ? await job.workerClient.generate(cell, grid.config, settings, { signal })
                    : STLHexGenerator.generateHexSTL(cell, grid, processor, settings);
                return { name: `hex_3d_${cell.label}.stl`, blob: buffer ? new Blob([buffer], { type: 'application/octet-stream' }) : null };
            }
        });
    }

    /**
     * Generuje instrukcję montażu w formacie HTML (zdatną do wydruku do PDF)
     */
    async generateAssemblyInstructions() {
        const activeCells = this.gridManager.getActiveCells();
        
        // 1. Zaktualizuj statystyki
        const dateStr = new Date().toLocaleDateString(i18n.locale === 'pl' ? 'pl-PL' : 'en-US');
        const timeStr = new Date().toLocaleTimeString(i18n.locale === 'pl' ? 'pl-PL' : 'en-US', { hour: '2-digit', minute: '2-digit' });
        document.querySelector('.instruction-date').textContent = i18n.t('generated_date', { date: dateStr, time: timeStr });
        document.getElementById('inst-stat-total').textContent = activeCells.length;

        const bbox = this.gridManager.getBoundingBoxMm();
        document.getElementById('inst-stat-dimensions').textContent = `${Math.round(bbox.width)} x ${Math.round(bbox.height)} mm`;
        document.getElementById('inst-stat-hexsize').textContent = `${this.gridManager.config.hexSize} mm`;
        document.getElementById('inst-stat-gap').textContent = `${this.gridManager.config.gap} mm`;

        // 2. Rysuj schemat ściany na instrukcji
        this.renderInstructionLayoutCanvas(bbox);

        // 3. Wygeneruj wiersze tabeli z miniaturkami
        const tbody = document.getElementById('instructions-table-body');
        tbody.innerHTML = ''; // wyczyść stary wykaz

        if (activeCells.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = `<td colspan="5" style="text-align: center;">${i18n.t('no_active_hexes')}</td>`;
            tbody.appendChild(row);
            return;
        }

        // Pobierz ustawienia ramki
        const frameEnable = this.gridManager.config.frameEnable;
        const frameType = document.getElementById('frame-type').value;
        const frameWidth = numericInput('frame-width', 2, 0, 50);
        const clearance = numericInput('frame-clearance', 0.2, 0, 5);
        const frameColor = document.getElementById('frame-color').value || '#1a1a1a';
        const dimensions = HexMath.getHexDimensions(this.gridManager.config.hexSize, this.gridManager.config.orientation);
        const thumbnailDpi = Math.min(72, 160 * 25.4 / (Math.max(dimensions.width, dimensions.height) + 2.4 * (frameWidth + clearance)));
        const thumbnailGrid = Object.assign(Object.create(Object.getPrototypeOf(this.gridManager)), this.gridManager, {
            config: { ...this.gridManager.config, dpi: thumbnailDpi }
        });

        // Dodaj wiersze dla każdego aktywnego heksu
        for (const cell of activeCells) {
            const tr = document.createElement('tr');
            
            // Etykieta / Kod
            const tdCode = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = 'inst-code-badge';
            badge.textContent = cell.label;
            tdCode.appendChild(badge);
            tr.appendChild(tdCode);

            // Pozycja (Kolumna / Wiersz)
            const tdPos = document.createElement('td');
            tdPos.innerHTML = i18n.t('col_row_info', { col: Number(cell.col) + 1, row: Number(cell.row) + 1 });
            tr.appendChild(tdPos);

            // Miniaturka grafiki (heksu)
            const tdPreview = document.createElement('td');
            const previewCellDiv = document.createElement('div');
            previewCellDiv.className = 'inst-hex-preview-cell';
            
            if (cell.imageId && this.imageProcessor.getImage(cell.imageId)) {
                const hexCanvas = this.imageProcessor.createHexagonCanvas(cell, thumbnailGrid);
                if (hexCanvas) {
                    hexCanvas.setAttribute('role', 'img');
                    hexCanvas.setAttribute('aria-label', cell.label);
                    previewCellDiv.appendChild(hexCanvas);
                }
            } else {
                previewCellDiv.innerHTML = `<span style="font-size: 0.6rem; color: #aaa;">${i18n.t('no_graphic')}</span>`;
            }
            tdPreview.appendChild(previewCellDiv);
            tr.appendChild(tdPreview);

            // Miniaturka kształtu ramki
            const tdFramePreview = document.createElement('td');
            const framePreviewDiv = document.createElement('div');
            framePreviewDiv.className = 'inst-hex-preview-cell';

            if (frameEnable) {
                try {
                    // Generujemy podgląd ramki na niskim DPI
                    const frameCanvas = FrameGenerator.createFrameCanvas(
                         cell,
                         this.gridManager,
                         frameType,
                         frameWidth,
                         clearance,
                         frameColor,
                         thumbnailDpi
                    );
                    if (frameCanvas) {
                        frameCanvas.setAttribute('role', 'img');
                        frameCanvas.setAttribute('aria-label', cell.label);
                        framePreviewDiv.appendChild(frameCanvas);
                    }
                } catch (err) {
                    console.error(`Błąd generowania podglądu ramki dla ${cell.label}:`, err);
                    framePreviewDiv.innerHTML = `<span style="font-size: 0.6rem; color: #aaa;">${i18n.t('gen_error')}</span>`;
                }
            } else {
                framePreviewDiv.innerHTML = `<span style="font-size: 0.6rem; color: #aaa;">${i18n.t('frames_disabled')}</span>`;
            }
            tdFramePreview.appendChild(framePreviewDiv);
            tr.appendChild(tdFramePreview);

            // Opis i wymiary montażowe
            const hexDim = HexMath.getHexDimensions(this.gridManager.config.hexSize, this.gridManager.config.orientation);
            const imageObj = cell.imageId ? this.imageProcessor.getImage(cell.imageId) : null;
            const imageName = imageObj ? imageObj.name : i18n.t('not_assigned');

            const tdDesc = document.createElement('td');
            tdDesc.innerHTML = `
                ${i18n.t('print_size')} <strong>${Math.round(hexDim.width)} x ${Math.round(hexDim.height)} mm</strong><br>
                ${i18n.t('source_image')} <code></code><br>
                ${frameEnable ? `${i18n.t('outer_frame_width')} <strong>${frameWidth} mm</strong>` : ''}
                <span style="font-size: 0.8rem; color: #666; margin-top: 4px; display: block;">
                    ${i18n.t('inst_mount_desc')}
                </span>
            `;
            tdDesc.querySelector('code').textContent = imageName;
            tr.appendChild(tdDesc);

            tbody.appendChild(tr);
        }
    }

    /**
     * Rysuje uproszczony schemat z numeracją heksów na potrzeby instrukcji
     */
    renderInstructionLayoutCanvas(bbox) {
        const canvas = document.getElementById('instruction-layout-canvas');
        const ctx = canvas.getContext('2d');
        
        // Zabezpieczenie przed dzieleniem przez zero i brak heksów
        if (bbox.width === 0 || bbox.height === 0) {
            canvas.width = 100;
            canvas.height = 100;
            ctx.clearRect(0, 0, 100, 100);
            return;
        }

        // Bound memory independently of the physical wall size, with space for outer frames.
        const marginMm = this.gridManager.config.frameEnable
            ? (this.gridManager.config.frameWidth + this.gridManager.config.frameClearance) * 2 + 2 : 0;
        const scale = Math.min(2, 1960 / (bbox.width + 2 * marginMm), 1960 / (bbox.height + 2 * marginMm));
        const padding = 20 + marginMm * scale;
        canvas.width = Math.ceil(bbox.width * scale + 2 * padding);
        canvas.height = Math.ceil(bbox.height * scale + 2 * padding);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Ustawienia transformacji rysowania
        ctx.save();
        ctx.translate(-bbox.minX * scale + padding, -bbox.minY * scale + padding);

        const hexSize = this.gridManager.config.hexSize;
        const orientation = this.gridManager.config.orientation;
        const stagger = this.gridManager.config.stagger || 'left';
        const gap = this.gridManager.config.gap;
        
        const activeCells = this.gridManager.getActiveCells();

        // Parametry ramek
        const frameEnable = this.gridManager.config.frameEnable;
        const frameWidth = this.gridManager.config.frameWidth;
        const clearance = this.gridManager.config.frameClearance;
        const frameColor = document.getElementById('frame-color').value || '#1a1a1a';

        // Rysuj wypełnienia heksów z grafiką jako jasnoszary lub miniatura
        activeCells.forEach(cell => {
            const pos = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
            
            let innerVerticesMm, outerVerticesMm;
            
            if (frameEnable) {
                const frameVerts = FrameGenerator.getFrameVerticesMm(cell, this.gridManager, frameWidth, clearance);
                innerVerticesMm = frameVerts.innerVerticesMm;
                outerVerticesMm = frameVerts.outerVerticesMm;
            } else {
                innerVerticesMm = HexMath.getCellVertices(cell, this.gridManager.config, hexSize);
                outerVerticesMm = [];
            }
            
            const toCanvasPixels = (v) => ({
                x: v.x * scale,
                y: v.y * scale
            });
            
            const innerVertices = innerVerticesMm.map(toCanvasPixels);
            const outerVertices = outerVerticesMm.map(toCanvasPixels);

            ctx.save();

            // 1. Rysuj ramkę wokół heksa (jeśli włączona)
            if (frameEnable && outerVertices.length > 0) {
                ctx.fillStyle = frameColor;
                ctx.beginPath();
                outerVertices.forEach((v, idx) => {
                    if (idx === 0) ctx.moveTo(v.x, v.y);
                    else ctx.lineTo(v.x, v.y);
                });
                ctx.closePath();

                const revInner = [...innerVertices].reverse();
                revInner.forEach((v, idx) => {
                    if (idx === 0) ctx.moveTo(v.x, v.y);
                    else ctx.lineTo(v.x, v.y);
                });
                ctx.closePath();
                ctx.fill('evenodd');
            }

            // 2. Wypełnienie heksa (otwór wewnętrzny)
            ctx.fillStyle = '#f9fafb';
            ctx.beginPath();
            innerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();

            // 3. Cienka ciemna ramka wewnętrzna dla estetyki otworu
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            innerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.stroke();

            // 4. Numeracja/Etykieta w środku (obliczona średnia wierzchołków dla optymalnego wycentrowania)
            let sumX = 0, sumY = 0;
            innerVertices.forEach(v => {
                sumX += v.x;
                sumY += v.y;
            });
            const textCenter = innerVertices.length > 0 ? { x: sumX / innerVertices.length, y: sumY / innerVertices.length } : { x: pos.x * scale, y: pos.y * scale };

            ctx.fillStyle = '#000000';
            ctx.font = `bold ${Math.round(hexSize * 0.3 * scale)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cell.label, textCenter.x, textCenter.y);

            ctx.restore();
        });

        ctx.restore();
    }
}

export default ExportManager;
