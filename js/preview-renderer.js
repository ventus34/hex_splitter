import HexMath from './hex-math.js?v=1.0.3';
import FrameGenerator from './frame-generator.js?v=1.0.3';

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
            showRuler: true,
            background: 'dark', // 'transparent' | 'dark' | 'light' | 'wall'
            amsPreview: false,
            amsColors: 4
        };

        this.renderRequested = false;

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
        const bbox = this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const worldX = (screenX - this.canvas.width / 2 - this.panX) / this.zoom + gridCenterX;
        const worldY = (screenY - this.canvas.height / 2 - this.panY) / this.zoom + gridCenterY;

        return { x: worldX, y: worldY };
    }

    worldToScreen(worldX, worldY) {
        const bbox = this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const screenX = (worldX - gridCenterX) * this.zoom + this.canvas.width / 2 + this.panX;
        const screenY = (worldY - gridCenterY) * this.zoom + this.canvas.height / 2 + this.panY;

        return { x: screenX, y: screenY };
    }

    initEvents() {
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        this.canvas.addEventListener('mousedown', e => {
            if (e.button === 0 || e.button === 1 || e.button === 2) {
                this.isPanning = true;
                this.startX = e.clientX - this.panX;
                this.startY = e.clientY - this.panY;
                this.canvas.style.cursor = 'grabbing';
            }
        });

        this.canvas.addEventListener('mousemove', e => {
            if (this.isPanning) {
                this.panX = e.clientX - this.startX;
                this.panY = e.clientY - this.startY;
                this.scheduleRender();
            }
        });

        window.addEventListener('mouseup', () => {
            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.style.cursor = 'default';
            }
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
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        return canvas.getContext('2d');
    }

    render() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        this.ctx.clearRect(0, 0, w, h);

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
        const drawCtx = useOffscreen ? this.createOffscreenCtx(w, h) : this.ctx;

        // 2. Rysuj ramki pod spodem (jeśli włączone)
        if (this.options.showFrames) {
            const frameType = document.getElementById('frame-type').value;
            const frameWidth = parseFloat(document.getElementById('frame-width').value) || 2;
            const clearance = parseFloat(document.getElementById('frame-clearance').value) || 0.2;
            const frameColor = document.getElementById('frame-color').value || '#1a1a1a';
            activeCells.forEach(cell => {
                this.drawFrame(drawCtx, cell, hexSize, orientation, gap, frameType, frameWidth, clearance, frameColor);
            });
        }

        // 3. Rysuj obrazy heksów
        activeCells.forEach(cell => {
            const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
            const screenPos = this.worldToScreen(posMm.x, posMm.y);
            const screenHexSize = hexSize * this.zoom;

            const vertices = HexMath.getHexVertices(screenPos.x, screenPos.y, screenHexSize, orientation);

            drawCtx.save();
            
            // Przytnij do heksagonu
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

                if (crop) {
                    drawCtx.drawImage(
                        imageObj.imgElement,
                        crop.x, crop.y, crop.w, crop.h,
                        screenPos.x - drawW / 2, screenPos.y - drawH / 2,
                        drawW, drawH
                    );
                } else {
                    drawCtx.drawImage(
                        imageObj.imgElement,
                        screenPos.x - drawW / 2, screenPos.y - drawH / 2,
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
            this.quantizeColors(drawCtx, w, h, parseInt(this.options.amsColors) || 4);
            
            // Narysuj cień dla całej warstwy płytek na głównym płótnie
            if (this.options.background !== 'transparent') {
                this.ctx.save();
                this.ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
                this.ctx.shadowBlur = 16 * this.zoom;
                this.ctx.shadowOffsetX = 4 * this.zoom;
                this.ctx.shadowOffsetY = 8 * this.zoom;
                this.ctx.drawImage(drawCtx.canvas, 0, 0);
                this.ctx.restore();
            } else {
                this.ctx.drawImage(drawCtx.canvas, 0, 0);
            }
        }

        // 5. Rysuj etykiety (na samym końcu, zawsze na głównym płótnie, by były ostre)
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

        // 6. Rysuj miarkę (jeśli włączona)
        if (this.options.showRuler) {
            this.drawRulers(w, h);
        }
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
        const stagger = this.gridManager.config.stagger || 'left';
        const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        const screenPos = this.worldToScreen(posMm.x, posMm.y);

        // Rozmiar wewnętrzny ramki (rozmiar heksa + tolerancja)
        const innerHexSizeMm = hexSize + clearanceMm;
        const innerHexSizePx = innerHexSizeMm * this.zoom;

        // Ustalenie offsetów dla każdego boku (na podglądzie w pikselach)
        const offsetsMm = [];
        for (let i = 0; i < 6; i++) {
            const isShared = HexMath.isEdgeShared(cell, i, this.gridManager);
            offsetsMm.push(isShared ? this.gridManager.config.gap / 2 : frameWidthMm);
        }
        const offsetsPx = offsetsMm.map(o => o * this.zoom);

        const outerVertices = HexMath.getOffsetOuterVertices(screenPos.x, screenPos.y, innerHexSizePx, orientation, offsetsPx);
        const innerVertices = HexMath.getHexVertices(screenPos.x, screenPos.y, innerHexSizePx, orientation);

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
        const data = imageData.data;
        
        // 1. Wybierz reprezentatywne piksele (próbkowanie)
        const pixels = [];
        for (let i = 0; i < data.length; i += 120) {
            const a = data[i + 3];
            if (a > 50) { // ignoruj tło/przezroczystość
                pixels.push([data[i], data[i+1], data[i+2]]);
            }
        }

        if (pixels.length < colorCount) return;

        // 2. Inicjalizacja centroidów (K-Means++)
        let centroids = [];
        centroids.push(pixels[Math.floor(Math.random() * pixels.length)]);
        
        for (let k = 1; k < colorCount; k++) {
            let maxDistSq = -1;
            let nextCentroid = null;
            for (let i = 0; i < pixels.length; i += 10) {
                const p = pixels[i];
                let minDistSq = Infinity;
                for (const c of centroids) {
                    const distSq = (p[0] - c[0])**2 + (p[1] - c[1])**2 + (p[2] - c[2])**2;
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                    }
                }
                if (minDistSq > maxDistSq) {
                    maxDistSq = minDistSq;
                    nextCentroid = p;
                }
            }
            centroids.push(nextCentroid || pixels[Math.floor(Math.random() * pixels.length)]);
        }

        // 3. Iteracje K-Means
        for (let iter = 0; iter < 5; iter++) {
            const groups = Array.from({ length: colorCount }, () => []);
            for (const p of pixels) {
                let minDistSq = Infinity;
                let groupIdx = 0;
                for (let c = 0; c < colorCount; c++) {
                    const distSq = (p[0] - centroids[c][0])**2 + (p[1] - centroids[c][1])**2 + (p[2] - centroids[c][2])**2;
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                        groupIdx = c;
                    }
                }
                groups[groupIdx].push(p);
            }

            for (let c = 0; c < colorCount; c++) {
                if (groups[c].length === 0) continue;
                let sumR = 0, sumG = 0, sumB = 0;
                for (const p of groups[c]) {
                    sumR += p[0];
                    sumG += p[1];
                    sumB += p[2];
                }
                centroids[c] = [
                    Math.round(sumR / groups[c].length),
                    Math.round(sumG / groups[c].length),
                    Math.round(sumB / groups[c].length)
                ];
            }
        }

        // 4. Mapowanie pikseli z powrotem
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a > 50) {
                const r = data[i];
                const g = data[i+1];
                const b = data[i+2];
                
                let minDistSq = Infinity;
                let nearest = centroids[0];
                for (const c of centroids) {
                    const distSq = (r - c[0])**2 + (g - c[1])**2 + (b - c[2])**2;
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                        nearest = c;
                    }
                }
                data[i] = nearest[0];
                data[i + 1] = nearest[1];
                data[i + 2] = nearest[2];
            }
        }

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
            const grad = this.ctx.createRadialGradient(
                w / 2, h / 2, 50,
                w / 2, h / 2, Math.max(w, h)
            );
            grad.addColorStop(0, '#2b3245');
            grad.addColorStop(1, '#080a0f');
            this.ctx.fillStyle = grad;
            this.ctx.fillRect(0, 0, w, h);
            
            this.ctx.save();
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
            for (let i = 0; i < 50000; i++) {
                const x = Math.random() * w;
                const y = Math.random() * h;
                this.ctx.fillRect(x, y, 1, 1);
            }
            this.ctx.restore();
        }
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
