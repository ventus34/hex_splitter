import HexMath from './hex-math.js?v=1.0.3';
import FrameGenerator from './frame-generator.js?v=1.0.3';
import { parseBoundedNumber } from './project-validation.js?v=1.0.3';
import AmsQuantizerClient from './ams-quantizer-client.js?v=1.0.3';
import { quantizeRgbaPixels } from './ams-quantizer.js?v=1.0.3';

class PreviewRenderer {
    constructor(canvasId, gridManager, imageProcessor) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.gridManager = gridManager;
        this.imageProcessor = imageProcessor;

        // Kopiuj parametry interakcji z WallPlannera, żeby zachować spójność
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        
        this.isPanning = false;
        this.startX = 0;
        this.startY = 0;

        // Opcje podglądu
        this.options = {
            showGaps: true,
            showLabels: true,
            showFrames: false,
            showHangers: false,
            showRuler: true,
            background: 'dark', // 'transparent' | 'dark' | 'light' | 'wall'
            amsPreview: false,
            amsColors: 4
        };

        this.renderRequested = false;
        this.renderTransform = null;
        this.offscreenCanvas = document.createElement('canvas');
        this.amsCacheCanvas = document.createElement('canvas');
        this.amsCacheKey = null;
        this.amsCurrentSceneKey = null;
        this.amsWorkerEnabled = true;
        this.amsWorkerFailed = false;
        this.wallTextureCanvas = null;
        this.wallTextureSize = '';
        this.sourceIds = new WeakMap();
        this.nextSourceId = 1;
        this.amsQuantizer = new AmsQuantizerClient({
            workerFactory: () => this.createAmsWorker(),
            isCurrent: job => this.isCurrentAmsJob(job),
            onResult: result => this.handleAmsWorkerResult(result),
            onError: (error, job) => this.handleAmsWorkerError(error, job)
        });
        this.handlePageHide = () => {
            this.amsQuantizer.cancel();
            this.amsCurrentSceneKey = null;
        };
        window.addEventListener('pagehide', this.handlePageHide);
        this.handlePageShow = () => {
            if (this.options.amsPreview) this.scheduleRender();
        };
        window.addEventListener('pageshow', this.handlePageShow);

        this.initEvents();
    }

    /**
     * Zleca renderowanie w kolejnej klatce animacji (requestAnimationFrame)
     */
    scheduleRender() {
        if (this.renderRequested) return;
        this.renderRequested = true;
        requestAnimationFrame(() => {
            this.render();
            this.renderRequested = false;
        });
    }

    resize() {
        const wrapper = this.canvas.parentElement;
        this.canvas.width = wrapper.clientWidth;
        this.canvas.height = wrapper.clientHeight;
        this.scheduleRender();
    }

    centerGrid() {
        const bbox = this.gridManager.getBoundingBoxMm();
        if (bbox.width === 0 || bbox.height === 0) return;

        const canvasW = this.canvas.width;
        const canvasH = this.canvas.height;

        const scaleX = canvasW / (bbox.width * 1.3);
        const scaleY = canvasH / (bbox.height * 1.3);
        this.zoom = Math.min(scaleX, scaleY, 4.0);
        this.zoom = Math.max(this.zoom, 0.1);

        this.panX = 0;
        this.panY = 0;
        this.scheduleRender();
    }

    screenToWorld(screenX, screenY) {
        const bbox = this.renderTransform?.bbox || this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const worldX = (screenX - this.canvas.width / 2 - this.panX) / this.zoom + gridCenterX;
        const worldY = (screenY - this.canvas.height / 2 - this.panY) / this.zoom + gridCenterY;

        return { x: worldX, y: worldY };
    }

    worldToScreen(worldX, worldY) {
        const bbox = this.renderTransform?.bbox || this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const screenX = (worldX - gridCenterX) * this.zoom + this.canvas.width / 2 + this.panX;
        const screenY = (worldY - gridCenterY) * this.zoom + this.canvas.height / 2 + this.panY;

        return { x: screenX, y: screenY };
    }

    initEvents() {
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        this.canvas.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch') {
                e.preventDefault();
                this.canvas.setPointerCapture?.(e.pointerId);
            }
            if (e.button === 0 || e.button === 1 || e.button === 2) {
                this.isPanning = true;
                this.startX = e.clientX - this.panX;
                this.startY = e.clientY - this.panY;
                this.canvas.style.cursor = 'grabbing';
            }
        });

        this.canvas.addEventListener('pointermove', e => {
            if (this.isPanning) {
                this.panX = e.clientX - this.startX;
                this.panY = e.clientY - this.startY;
                this.scheduleRender();
            }
        });

        window.addEventListener('pointerup', () => {
            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.style.cursor = 'default';
            }
        });
        window.addEventListener('pointercancel', () => {
            this.isPanning = false;
            this.canvas.style.cursor = 'default';
        });

        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const worldBefore = this.screenToWorld(mouseX, mouseY);

            const zoomFactor = 1.15;
            if (e.deltaY < 0) {
                this.zoom *= zoomFactor;
            } else {
                this.zoom /= zoomFactor;
            }
            this.zoom = Math.min(Math.max(this.zoom, 0.1), 4.0);

            const bbox = this.gridManager.getBoundingBoxMm();
            const gridCenterX = bbox.minX + bbox.width / 2;
            const gridCenterY = bbox.minY + bbox.height / 2;

            this.panX = mouseX - this.canvas.width / 2 - (worldBefore.x - gridCenterX) * this.zoom;
            this.panY = mouseY - this.canvas.height / 2 - (worldBefore.y - gridCenterY) * this.zoom;

            this.scheduleRender();
        }, { passive: false });
    }

    createOffscreenCtx(w, h) {
        if (this.offscreenCanvas.width !== w || this.offscreenCanvas.height !== h) {
            this.offscreenCanvas.width = w;
            this.offscreenCanvas.height = h;
        }
        const ctx = this.offscreenCanvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        return ctx;
    }

    readNumberInput(id, fallback) {
        const input = document.getElementById(id);
        if (!input) return fallback;
        const min = input.min === '' ? -Infinity : Number(input.min);
        const max = input.max === '' ? Infinity : Number(input.max);
        return parseBoundedNumber(input.value, fallback, min, max);
    }

    render() {
        this.renderTransform = { bbox: this.gridManager.getBoundingBoxMm() };
        try {
            this.renderFrame();
        } finally {
            this.renderTransform = null;
        }
    }

    renderFrame() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        this.ctx.clearRect(0, 0, w, h);

        if (w === 0 || h === 0) {
            this.amsQuantizer.cancel();
            this.amsCurrentSceneKey = null;
            return;
        }

        // 1. Rysuj wybrane tło
        this.drawBackground(w, h);

        const activeCells = this.gridManager.getActiveCells();
        const hexSize = this.gridManager.config.hexSize;
        const orientation = this.gridManager.config.orientation;
        const stagger = this.gridManager.config.stagger || 'left';
        const gap = this.options.showGaps ? this.gridManager.config.gap : 0;
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);

        // Offscreen canvas dla samych elementów heksów i ramek (dzięki temu kwantyzacja nie uszkodzi tła ani etykiet)
        const useOffscreen = this.options.amsPreview;
        const cacheKey = useOffscreen ? this.getAmsCacheKey(activeCells, w, h) : null;
        const cacheHit = useOffscreen && this.amsCacheKey === cacheKey;
        this.amsCurrentSceneKey = cacheKey;
        if (!useOffscreen) {
            this.amsQuantizer.cancel();
            this.amsCurrentSceneKey = null;
        }
        const drawCtx = useOffscreen ? (cacheHit ? null : this.createOffscreenCtx(w, h)) : this.ctx;

        // 2. Rysuj ramki pod spodem (jeśli włączone)
        if (this.options.showFrames && drawCtx) {
            const frameType = document.getElementById('frame-type').value;
            const frameWidth = this.readNumberInput('frame-width', 2);
            const clearance = this.readNumberInput('frame-clearance', 0.2);
            const frameColor = document.getElementById('frame-color').value || '#1a1a1a';
            activeCells.forEach(cell => {
                this.drawFrame(drawCtx, cell, hexSize, orientation, gap, frameType, frameWidth, clearance, frameColor);
            });
        }

        // 3. Rysuj obrazy heksów
        if (drawCtx) activeCells.forEach(cell => {
            const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
            const screenCenter = this.worldToScreen(posMm.x, posMm.y);

            const verticesMm = HexMath.getCellVertices(cell, this.gridManager.config);
            const vertices = verticesMm.map(v => this.worldToScreen(v.x, v.y));

            drawCtx.save();
            
            // Przytnij do heksagonu/wielokąta
            drawCtx.beginPath();
            vertices.forEach((v, idx) => {
                if (idx === 0) drawCtx.moveTo(v.x, v.y);
                else drawCtx.lineTo(v.x, v.y);
            });
            drawCtx.closePath();
            
            // Cień heksów na ścianie dla fotorealizmu (tylko na nie-transparentnym tle i bez offscreen)
            if (!useOffscreen && this.options.background !== 'transparent') {
                drawCtx.shadowColor = 'rgba(0, 0, 0, 0.4)';
                drawCtx.shadowBlur = 12 * this.zoom;
                drawCtx.shadowOffsetX = 3 * this.zoom;
                drawCtx.shadowOffsetY = 6 * this.zoom;
            }

            drawCtx.clip();

            if (cell.imageId && this.imageProcessor.getImage(cell.imageId)) {
                const imageObj = this.imageProcessor.getImage(cell.imageId);
                const crop = cell.cropRegion;
                const drawW = hexDim.width * this.zoom;
                const drawH = hexDim.height * this.zoom;

                const sourceElement = this.imageProcessor.getRotatedCanvasOrImage(imageObj);
                if (crop) {
                    drawCtx.drawImage(
                        sourceElement,
                        crop.x, crop.y, crop.w, crop.h,
                        screenCenter.x - drawW / 2, screenCenter.y - drawH / 2,
                        drawW, drawH
                    );
                } else {
                    drawCtx.drawImage(
                        sourceElement,
                        screenCenter.x - drawW / 2, screenCenter.y - drawH / 2,
                        drawW, drawH
                    );
                }
            } else {
                // Szare wypełnienie komórek bez grafiki
                drawCtx.fillStyle = '#444c5e';
                drawCtx.fill();
            }

            drawCtx.restore();
        });

        // 4. Jeśli używamy offscreen, zastosuj kwantyzację kolorów i nałóż na główny canvas
        if (useOffscreen) {
            if (cacheHit) {
                this.amsQuantizer.cancelPending();
            } else if (!this.amsWorkerEnabled || this.amsWorkerFailed || typeof Worker === 'undefined') {
                this.quantizeAndCacheOffscreen(cacheKey, w, h, parseInt(this.options.amsColors) || 4);
            } else {
                const colorCount = parseInt(this.options.amsColors) || 4;
                const accepted = this.amsQuantizer.submit({
                    key: cacheKey,
                    width: w,
                    height: h,
                    colorCount,
                    readImageData: () => this.offscreenCanvas.getContext('2d').getImageData(0, 0, w, h)
                });
                if (!accepted) {
                    this.amsWorkerFailed = true;
                    this.quantizeAndCacheOffscreen(cacheKey, w, h, colorCount);
                }
            }

            // Keep navigation responsive: while quantization is pending, show the
            // current scene's raw raster rather than an old scene's AMS cache.
            const rasterCanvas = cacheHit || this.amsCacheKey === cacheKey
                ? this.amsCacheCanvas
                : this.offscreenCanvas;
            
            // Narysuj cień dla całej warstwy płytek na głównym płótnie
            if (this.options.background !== 'transparent') {
                this.ctx.save();
                this.ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
                this.ctx.shadowBlur = 16 * this.zoom;
                this.ctx.shadowOffsetX = 4 * this.zoom;
                this.ctx.shadowOffsetY = 8 * this.zoom;
                this.ctx.drawImage(rasterCanvas, 0, 0);
                this.ctx.restore();
            } else {
                this.ctx.drawImage(rasterCanvas, 0, 0);
            }
        }

        // 5. Rysuj uchwyty ścienne (Y-splitters) jeśli włączone
        if (this.options.showHangers) {
            this.drawHangers(this.ctx);
        }
 
        // 6. Rysuj etykiety (na samym końcu, zawsze na głównym płótnie, by były ostre)
        if (this.options.showLabels) {
            activeCells.forEach(cell => {
                const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
                const screenPos = this.worldToScreen(posMm.x, posMm.y);

                this.ctx.save();
                this.ctx.fillStyle = '#ffffff';
                this.ctx.font = `bold ${Math.max(9, Math.min(13, 11 * this.zoom))}px 'Inter', sans-serif`;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                
                const text = cell.label;
                const textWidth = this.ctx.measureText(text).width;
                this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                this.ctx.fillRect(screenPos.x - textWidth/2 - 3, screenPos.y - 7, textWidth + 6, 14);
                
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fillText(text, screenPos.x, screenPos.y);
                this.ctx.restore();
            });
        }

        // 7. Rysuj miarkę (jeśli włączona)
        if (this.options.showRuler) {
            this.drawRulers(w, h);
        }
    }

    getAmsCacheKey(activeCells, width, height) {
        const frameSettings = this.options.showFrames ? [
            document.getElementById('frame-type')?.value,
            document.getElementById('frame-width')?.value,
            document.getElementById('frame-clearance')?.value,
            document.getElementById('frame-color')?.value
        ] : null;
        const cells = activeCells.map(cell => {
            const imageObj = cell.imageId ? this.imageProcessor.getImage(cell.imageId) : null;
            const source = imageObj ? this.imageProcessor.getRotatedCanvasOrImage(imageObj) : null;
            let sourceId = 0;
            if (source) {
                sourceId = this.sourceIds.get(source);
                if (!sourceId) {
                    sourceId = this.nextSourceId++;
                    this.sourceIds.set(source, sourceId);
                }
            }
            const crop = cell.cropRegion;
            return [cell.q, cell.r, cell.imageId, sourceId, crop?.x, crop?.y, crop?.w, crop?.h];
        });

        return JSON.stringify([
            width, height, this.options.amsColors, this.options.showGaps, this.options.showFrames,
            this.options.background, this.zoom, this.panX, this.panY, this.gridManager.config,
            frameSettings, cells
        ]);
    }

    createAmsWorker() {
        return new Worker(new URL('./ams-quantizer.worker.js', import.meta.url), { type: 'module' });
    }

    isCurrentAmsJob(job) {
        if (!this.options.amsPreview || this.canvas.width !== job.width || this.canvas.height !== job.height) return false;
        return this.getAmsCacheKey(this.gridManager.getActiveCells(), job.width, job.height) === job.key;
    }

    handleAmsWorkerResult(result) {
        if (!this.isCurrentAmsJob(result)) return;
        const pixels = result.pixels instanceof ArrayBuffer
            ? new Uint8ClampedArray(result.pixels)
            : result.pixels;
        if (!(pixels instanceof Uint8ClampedArray) || pixels.byteLength !== result.width * result.height * 4) return;

        if (this.amsCacheCanvas.width !== result.width || this.amsCacheCanvas.height !== result.height) {
            this.amsCacheCanvas.width = result.width;
            this.amsCacheCanvas.height = result.height;
        }
        const cacheCtx = this.amsCacheCanvas.getContext('2d');
        const imageData = cacheCtx.createImageData(result.width, result.height);
        imageData.data.set(pixels);
        cacheCtx.putImageData(imageData, 0, 0);
        this.amsCacheKey = result.key;
        this.scheduleRender();
    }

    handleAmsWorkerError(_error, job) {
        this.amsWorkerFailed = true;
        if (job && this.isCurrentAmsJob(job)) this.scheduleRender();
    }

    quantizeAndCacheOffscreen(key, width, height, colorCount) {
        this.quantizeColors(this.offscreenCanvas.getContext('2d'), width, height, colorCount);
        if (this.amsCacheCanvas.width !== width || this.amsCacheCanvas.height !== height) {
            this.amsCacheCanvas.width = width;
            this.amsCacheCanvas.height = height;
        }
        const cacheCtx = this.amsCacheCanvas.getContext('2d');
        cacheCtx.clearRect(0, 0, width, height);
        cacheCtx.drawImage(this.offscreenCanvas, 0, 0);
        this.amsCacheKey = key;
    }

    /**
     * Rysuje linijkę (miarkę) u góry i z lewej strony ekranu podglądu
     */
    drawRulers(w, h) {
        const rulerSize = 26;

        this.ctx.save();
        
        // Wyłącz cienie dla linijki
        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;
        this.ctx.shadowOffsetX = 0;
        this.ctx.shadowOffsetY = 0;

        // Tło linijki
        this.ctx.fillStyle = '#0f111a';
        this.ctx.fillRect(0, 0, w, rulerSize); // Górna linijka
        this.ctx.fillRect(0, 0, rulerSize, h); // Lewa linijka

        // Dynamiczne kroki miarki na podstawie aktualnego zoomu
        const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
        let step = steps[steps.length - 1];
        for (let i = 0; i < steps.length; i++) {
            if (steps[i] * this.zoom >= 50) {
                step = steps[i];
                break;
            }
        }

        const subdivisions = 5;
        const subStep = step / subdivisions;

        const xMin = this.screenToWorld(rulerSize, 0).x;
        const xMax = this.screenToWorld(w, 0).x;
        const yMin = this.screenToWorld(0, rulerSize).y;
        const yMax = this.screenToWorld(0, h).y;

        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        this.ctx.font = "9px 'Inter', sans-serif";
        this.ctx.lineWidth = 1;

        // --- GÓRNA LINIJKA (Oś X) ---
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';

        const startX = Math.floor(xMin / step) * step;
        const endX = Math.ceil(xMax / step) * step;

        for (let xVal = startX; xVal <= endX; xVal += step) {
            const screenX = this.worldToScreen(xVal, 0).x;
            if (screenX < rulerSize || screenX > w) continue;

            // Główna kreska (major tick)
            this.ctx.beginPath();
            this.ctx.moveTo(screenX, rulerSize - 10);
            this.ctx.lineTo(screenX, rulerSize);
            this.ctx.stroke();

            // Podpis
            this.ctx.fillText(Math.round(xVal).toString(), screenX, 3);

            // Drobne kreski (minor ticks)
            for (let k = 1; k < subdivisions; k++) {
                const minorXVal = xVal + k * subStep;
                const minorScreenX = this.worldToScreen(minorXVal, 0).x;
                if (minorScreenX < rulerSize || minorScreenX > w) continue;

                this.ctx.beginPath();
                this.ctx.moveTo(minorScreenX, rulerSize - 5);
                this.ctx.lineTo(minorScreenX, rulerSize);
                this.ctx.stroke();
            }
        }

        // --- LEWA LINIJKA (Oś Y) ---
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'middle';
        
        const startY = Math.floor(yMin / step) * step;
        const endY = Math.ceil(yMax / step) * step;

        for (let yVal = startY; yVal <= endY; yVal += step) {
            const screenY = this.worldToScreen(0, yVal).y;
            if (screenY < rulerSize || screenY > h) continue;

            // Główna kreska (major tick)
            this.ctx.beginPath();
            this.ctx.moveTo(rulerSize - 10, screenY);
            this.ctx.lineTo(rulerSize, screenY);
            this.ctx.stroke();

            // Podpis
            this.ctx.fillText(Math.round(yVal).toString(), rulerSize - 13, screenY);

            // Drobne kreski (minor ticks)
            for (let k = 1; k < subdivisions; k++) {
                const minorYVal = yVal + k * subStep;
                const minorScreenY = this.worldToScreen(0, minorYVal).y;
                if (minorScreenY < rulerSize || minorScreenY > h) continue;

                this.ctx.beginPath();
                this.ctx.moveTo(rulerSize - 5, minorScreenY);
                this.ctx.lineTo(rulerSize, minorScreenY);
                this.ctx.stroke();
            }
        }

        // Narożnik (punkt 0,0)
        this.ctx.fillStyle = '#0f111a';
        this.ctx.fillRect(0, 0, rulerSize, rulerSize);
        
        // Granice linijki
        this.ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        // Linia pozioma linijki
        this.ctx.moveTo(0, rulerSize);
        this.ctx.lineTo(w, rulerSize);
        // Linia pionowa linijki
        this.ctx.moveTo(rulerSize, 0);
        this.ctx.lineTo(rulerSize, h);
        this.ctx.stroke();

        // Jednostka "mm" w narożniku
        this.ctx.fillStyle = '#00e5ff';
        this.ctx.font = "bold 9px 'Inter', sans-serif";
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText("mm", rulerSize / 2, rulerSize / 2);

        this.ctx.restore();
    }

    /**
     * Rysuje ramkę pod heksagonem z wizualizacją złączy
     */
    drawFrame(ctx, cell, hexSize, orientation, gap, type, frameWidthMm, clearanceMm, frameColor) {
        const { innerVerticesMm, outerVerticesMm } = FrameGenerator.getFrameVerticesMm(cell, this.gridManager, frameWidthMm, clearanceMm);

        const innerVertices = innerVerticesMm.map(v => this.worldToScreen(v.x, v.y));
        const outerVertices = outerVerticesMm.map(v => this.worldToScreen(v.x, v.y));

        ctx.save();
        
        // Dodaj cień do samej ramki (tylko gdy rysujemy bezpośrednio na ctx)
        if (ctx === this.ctx && this.options.background !== 'transparent') {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
            ctx.shadowBlur = 16 * this.zoom;
            ctx.shadowOffsetX = 4 * this.zoom;
            ctx.shadowOffsetY = 8 * this.zoom;
        }

        if (type === 'backing') {
            ctx.fillStyle = frameColor;
            ctx.beginPath();
            outerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();
        } 
        else if (type === 'outline') {
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
        else if (type === 'sleeve') {
            ctx.fillStyle = this.adjustColorBrightness(frameColor, -20);
            ctx.beginPath();
            outerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();

            // Nakładka border
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

        ctx.restore();
    }

    /**
     * Szybki algorytm K-Means do kwantyzacji kolorów na podglądzie
     */
    quantizeColors(offscreenCtx, w, h, colorCount) {
        const imageData = offscreenCtx.getImageData(0, 0, w, h);
        quantizeRgbaPixels(imageData.data, colorCount);
        offscreenCtx.putImageData(imageData, 0, 0);
    }

    /**
     * Rysuje tło podglądu ściany
     */
    drawBackground(w, h) {
        const bg = this.options.background;
        
        if (bg === 'transparent') {
            const size = 20;
            for (let x = 0; x < w; x += size * 2) {
                for (let y = 0; y < h; y += size * 2) {
                    this.ctx.fillStyle = '#0f111a';
                    this.ctx.fillRect(x, y, size, size);
                    this.ctx.fillRect(x + size, y + size, size, size);
                    this.ctx.fillStyle = '#141824';
                    this.ctx.fillRect(x + size, y, size, size);
                    this.ctx.fillRect(x, y + size, size, size);
                }
            }
        } 
        else if (bg === 'dark') {
            this.ctx.fillStyle = '#0a0c10';
            this.ctx.fillRect(0, 0, w, h);
        } 
        else if (bg === 'light') {
            this.ctx.fillStyle = '#e9ecf0';
            this.ctx.fillRect(0, 0, w, h);
        } 
        else if (bg === 'wall') {
            const sizeKey = `${w}x${h}`;
            if (!this.wallTextureCanvas || this.wallTextureSize !== sizeKey) {
                const texture = document.createElement('canvas');
                texture.width = w;
                texture.height = h;
                const textureCtx = texture.getContext('2d');
                const grad = textureCtx.createRadialGradient(
                    w / 2, h / 2, 50,
                    w / 2, h / 2, Math.max(w, h)
                );
                grad.addColorStop(0, '#2b3245');
                grad.addColorStop(1, '#080a0f');
                textureCtx.fillStyle = grad;
                textureCtx.fillRect(0, 0, w, h);

                // Stable seeded texture: build once per canvas size instead of drawing
                // 50,000 random marks in every animation frame.
                let seed = (w * 73856093) ^ (h * 19349663) ^ 0x6d2b79f5;
                const random = () => {
                    seed ^= seed << 13;
                    seed ^= seed >>> 17;
                    seed ^= seed << 5;
                    return (seed >>> 0) / 4294967296;
                };
                textureCtx.fillStyle = 'rgba(255, 255, 255, 0.015)';
                for (let i = 0; i < 50000; i++) {
                    textureCtx.fillRect(random() * w, random() * h, 1, 1);
                }
                this.wallTextureCanvas = texture;
                this.wallTextureSize = sizeKey;
            }
            this.ctx.drawImage(this.wallTextureCanvas, 0, 0);
        }
    }

    getHangerJunctions() {
        const activeCells = this.gridManager.getActiveCells();
        const hexSize = this.gridManager.config.hexSize;
        const orientation = this.gridManager.config.orientation;
        const stagger = this.gridManager.config.stagger || 'left';
        
        const vertexMap = new Map();
        
        activeCells.forEach(cell => {
            const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, 0, stagger);
            const vertices = HexMath.getHexVertices(posMm.x, posMm.y, hexSize, orientation);
            
            vertices.forEach(v => {
                const key = `${v.x.toFixed(2)},${v.y.toFixed(2)}`;
                if (!vertexMap.has(key)) {
                    vertexMap.set(key, {
                        x: v.x,
                        y: v.y,
                        cells: []
                    });
                }
                const entry = vertexMap.get(key);
                entry.cells.push({
                    cell: cell,
                    center: posMm
                });
            });
        });
        
        const junctions = [];
        for (const [key, entry] of vertexMap.entries()) {
            if (entry.cells.length === 3) {
                junctions.push({
                    x: entry.x,
                    y: entry.y,
                    cells: entry.cells
                });
            }
        }
        
        return junctions;
    }

    drawHangers(ctx) {
        const junctions = this.getHangerJunctions();
        if (junctions.length === 0) return;

        const gap = parseBoundedNumber(this.gridManager.config.gap, 0, 0, 50);
        const hexSize = parseBoundedNumber(this.gridManager.config.hexSize, 100, 10, 500);
        
        const clearance = this.readNumberInput('hanger-clearance', 0.3);
        const configuredArmWidth = this.readNumberInput('hanger-arm-width', 12);
        const configuredArmLength = this.readNumberInput('hanger-arm-length', 30);
        const ridgeHeightMm = this.readNumberInput('hanger-ridge-height', 2.0);

        // Zabezpieczenie przed zbyt małymi heksami - ramiona nie mogą wykraczać poza obrys heksa (tak samo jak w hanger-generator.js)
        const maxArmLength = hexSize * 0.95;
        const armLengthMm = Math.min(configuredArmLength, maxArmLength);
        const armWidthMm = Math.min(configuredArmWidth, hexSize * 0.8);

        const ridgeWidthMm = Math.max(0, gap - clearance);

        ctx.save();
        
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        junctions.forEach(j => {
            const screenCenter = this.worldToScreen(j.x, j.y);
            
            const vectors = j.cells.map(c => ({
                x: c.center.x - j.x,
                y: c.center.y - j.y
            }));
            
            const armDirs = [];
            for (let i = 0; i < 3; i++) {
                const next = (i + 1) % 3;
                const sumX = vectors[i].x + vectors[next].x;
                const sumY = vectors[i].y + vectors[next].y;
                const len = Math.sqrt(sumX*sumX + sumY*sumY);
                if (len > 0) {
                    armDirs.push({ x: sumX / len, y: sumY / len });
                }
            }

            const armWidthPx = armWidthMm * this.zoom;
            const armLengthPx = armLengthMm * this.zoom;
            const centerRadiusPx = (armWidthMm / 2) * this.zoom;

            ctx.lineWidth = armWidthPx;
            ctx.lineCap = 'butt';
            ctx.strokeStyle = 'rgba(255, 110, 0, 0.45)';
            ctx.fillStyle = 'rgba(255, 110, 0, 0.45)';

            // Cylinder centralny
            ctx.beginPath();
            ctx.arc(screenCenter.x, screenCenter.y, centerRadiusPx, 0, 2*Math.PI);
            ctx.fill();

            // Trzy ramiona
            armDirs.forEach(dir => {
                const endX = screenCenter.x + dir.x * armLengthPx;
                const endY = screenCenter.y + dir.y * armLengthPx;
                ctx.beginPath();
                ctx.moveTo(screenCenter.x, screenCenter.y);
                ctx.lineTo(endX, endY);
                ctx.stroke();
            });

            // Separatory (ridges)
            if (ridgeWidthMm > 0 && ridgeHeightMm > 0) {
                const ridgeWidthPx = ridgeWidthMm * this.zoom;
                ctx.lineWidth = Math.max(1.5, ridgeWidthPx);
                ctx.lineCap = 'butt';
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                
                armDirs.forEach(dir => {
                    const endX = screenCenter.x + dir.x * armLengthPx;
                    const endY = screenCenter.y + dir.y * armLengthPx;
                    ctx.beginPath();
                    ctx.moveTo(screenCenter.x, screenCenter.y);
                    ctx.lineTo(endX, endY);
                    ctx.stroke();
                });
            }
        });

        ctx.restore();
    }

    adjustColorBrightness(hex, percent) {
        let num = parseInt(hex.replace("#",""), 16),
            amt = Math.round(2.55 * percent),
            R = (num >> 16) + amt,
            G = (num >> 8 & 0x00FF) + amt,
            B = (num & 0x0000FF) + amt;
        return "#" + (0x1000000 + (R<255?R<0?0:R:255)*0x10000 + (G<255?G<0?0:G:255)*0x100 + (B<255?B<0?0:B:255)).toString(16).slice(1);
    }
}

export default PreviewRenderer;
