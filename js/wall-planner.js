import HexMath from './hex-math.js?v=1.0.3';

class WallPlanner {
    constructor(canvasId, gridManager, imageProcessor) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.gridManager = gridManager;
        this.imageProcessor = imageProcessor;

        // Stan widoku (Pan & Zoom)
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        
        // Stan interakcji
        this.isPanning = false;
        this.startX = 0;
        this.startY = 0;
        this.hoveredCellKey = null;
        
        // Drag over image state
        this.draggedImageId = null;

        // Tryb interakcji (siatka / przesuwanie zdjęć)
        this.interactionMode = 'grid'; // 'grid' | 'image'
        this.isDraggingImage = false;
        this.draggedCell = null;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

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

    /**
     * Centruje siatkę w oknie podglądu
     */
    centerGrid() {
        const bbox = this.gridManager.getBoundingBoxMm();
        if (bbox.width === 0 || bbox.height === 0) return;

        const canvasW = this.canvas.width;
        const canvasH = this.canvas.height;

        // Oblicz środek siatki w mm
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        // Oblicz skalę dopasowania (z marginesem 10%)
        const scaleX = canvasW / (bbox.width * 1.2);
        const scaleY = canvasH / (bbox.height * 1.2);
        this.zoom = Math.min(scaleX, scaleY, 4.0); // Ogranicz zoom do max 4x
        this.zoom = Math.max(this.zoom, 0.1); // Ogranicz do min 0.1x

        // Wyzeruj pan - centrowanie następuje automatycznie w renderze na podstawie środka siatki
        this.panX = 0;
        this.panY = 0;
        this.scheduleRender();
    }

    /**
     * Zamienia współrzędne ekranowe na mm
     */
    screenToWorld(screenX, screenY) {
        const bbox = this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const worldX = (screenX - this.canvas.width / 2 - this.panX) / this.zoom + gridCenterX;
        const worldY = (screenY - this.canvas.height / 2 - this.panY) / this.zoom + gridCenterY;

        return { x: worldX, y: worldY };
    }

    /**
     * Zamienia współrzędne mm na ekranowe
     */
    worldToScreen(worldX, worldY) {
        const bbox = this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const screenX = (worldX - gridCenterX) * this.zoom + this.canvas.width / 2 + this.panX;
        const screenY = (worldY - gridCenterY) * this.zoom + this.canvas.height / 2 + this.panY;

        return { x: screenX, y: screenY };
    }

    /**
     * Inicjalizuje zdarzenia myszy, dotyku i drag-and-drop
     */
    initEvents() {
        // Blokada prawego przycisku myszy dla przeciągania (pan)
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        // Mousedown / Touchstart
        this.canvas.addEventListener('mousedown', e => {
            if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
                // Środkowy, prawy lub LPM z Shift = Przesuwanie (Pan)
                this.isPanning = true;
                this.startX = e.clientX - this.panX;
                this.startY = e.clientY - this.panY;
                this.canvas.style.cursor = 'grabbing';
            } else if (e.button === 0) {
                // Lewy przycisk myszy = Toggle komórki lub przypisanie obrazu / przesuwanie obrazu
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                
                const world = this.screenToWorld(mouseX, mouseY);
                const hex = HexMath.pixelToAxial(
                    world.x, 
                    world.y, 
                    this.gridManager.config.hexSize, 
                    this.gridManager.config.orientation,
                    this.gridManager.config.gap,
                    this.gridManager.config.stagger || 'left'
                );

                const cell = this.gridManager.getCell(hex.q, hex.r);
                
                if (this.interactionMode === 'image') {
                    // Tryb przesuwania obrazu
                    const imageMode = document.querySelector('input[name="image-mode"]:checked').value;
                    if (imageMode === 'single') {
                        // W trybie jednej grafiki na całą ścianę przeciągamy całą siatkę (o ile jest aktywny obraz)
                        if (this.imageProcessor.activeImageId) {
                            this.isDraggingImage = true;
                            this.lastMouseX = e.clientX;
                            this.lastMouseY = e.clientY;
                            this.canvas.style.cursor = 'grabbing';
                        }
                    } else if (imageMode === 'multi') {
                        // W trybie wielu grafik przeciągamy obraz w konkretnym heksie
                        if (cell && cell.enabled && cell.imageId && cell.cropRegion) {
                            this.isDraggingImage = true;
                            this.draggedCell = cell;
                            this.lastMouseX = e.clientX;
                            this.lastMouseY = e.clientY;
                            this.canvas.style.cursor = 'grabbing';
                        }
                    }
                } else {
                    // Tryb siatki
                    if (cell) {
                        this.gridManager.toggleCell(hex.q, hex.r);
                        
                        // Po zmianie struktury, przelicz ponownie mapowanie (w trybie single-image)
                        const imageMode = document.querySelector('input[name="image-mode"]:checked').value;
                        if (imageMode === 'single') {
                            this.imageProcessor.recalculateSingleImageMapping(this.gridManager);
                        }
                        
                        this.scheduleRender();
                        
                        // Zdarzenie informujące o zmianie siatki
                        this.canvas.dispatchEvent(new CustomEvent('gridchange'));
                    }
                }
            }
        });

        // Mousemove
        this.canvas.addEventListener('mousemove', e => {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            if (this.isPanning) {
                this.panX = e.clientX - this.startX;
                this.panY = e.clientY - this.startY;
                this.scheduleRender();
            } else if (this.isDraggingImage) {
                const dx = e.clientX - this.lastMouseX;
                const dy = e.clientY - this.lastMouseY;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;

                const imageMode = document.querySelector('input[name="image-mode"]:checked').value;
                if (imageMode === 'single') {
                    // Przesuwanie całej grafiki w tle
                    this.gridManager.config.singleImageOffsetX = (this.gridManager.config.singleImageOffsetX || 0) + dx / this.zoom;
                    this.gridManager.config.singleImageOffsetY = (this.gridManager.config.singleImageOffsetY || 0) + dy / this.zoom;
                    this.imageProcessor.recalculateSingleImageMapping(this.gridManager);
                } else if (imageMode === 'multi' && this.draggedCell) {
                    // Przesuwanie obrazu w konkretnym heksie
                    const cell = this.draggedCell;
                    const imageObj = this.imageProcessor.getImage(cell.imageId);
                    if (imageObj && cell.cropRegion) {
                        const hexSize = this.gridManager.config.hexSize;
                        const orientation = this.gridManager.config.orientation;
                        const hexDim = HexMath.getHexDimensions(hexSize, orientation);

                        const drawW = hexDim.width * this.zoom;
                        const drawH = hexDim.height * this.zoom;

                        // Skala przeliczenia ekran -> piksele obrazu
                        const scaleImgX = cell.cropRegion.w / drawW;
                        const scaleImgY = cell.cropRegion.h / drawH;

                        // Nowe współrzędne kadru (ruch myszy w prawo -> przesuwamy kadr w lewo na obrazie źródłowym)
                        const newCropX = cell.cropRegion.x - dx * scaleImgX;
                        const newCropY = cell.cropRegion.y - dy * scaleImgY;

                        const imgWidth = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.width : imageObj.width;
                        const imgHeight = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.height : imageObj.height;

                        const minX = 0;
                        const maxX = imgWidth - cell.cropRegion.w;
                        const minY = 0;
                        const maxY = imgHeight - cell.cropRegion.h;

                        cell.cropRegion.x = Math.max(minX, Math.min(maxX, newCropX));
                        cell.cropRegion.y = Math.max(minY, Math.min(maxY, newCropY));
                    }
                }

                this.scheduleRender();
                this.canvas.dispatchEvent(new CustomEvent('gridchange'));
            } else {
                // Sprawdzanie hovera nad komórkami
                const world = this.screenToWorld(mouseX, mouseY);
                const hex = HexMath.pixelToAxial(
                    world.x, 
                    world.y, 
                    this.gridManager.config.hexSize, 
                    this.gridManager.config.orientation,
                    this.gridManager.config.gap,
                    this.gridManager.config.stagger || 'left'
                );

                const cell = this.gridManager.getCell(hex.q, hex.r);
                const newKey = cell ? `${hex.q},${hex.r}` : null;
                
                // Aktualizuj kursor myszy w trybie kadrowania
                if (this.interactionMode === 'image') {
                    const imageMode = document.querySelector('input[name="image-mode"]:checked').value;
                    if (imageMode === 'single') {
                        if (this.imageProcessor.activeImageId) {
                            this.canvas.style.cursor = 'grab';
                        } else {
                            this.canvas.style.cursor = 'default';
                        }
                    } else if (imageMode === 'multi') {
                        if (cell && cell.enabled && cell.imageId) {
                            this.canvas.style.cursor = 'grab';
                        } else {
                            this.canvas.style.cursor = 'default';
                        }
                    }
                } else {
                    this.canvas.style.cursor = 'default';
                }

                if (this.hoveredCellKey !== newKey) {
                    this.hoveredCellKey = newKey;
                    this.scheduleRender();
                }
            }
        });

        // Mouseup
        window.addEventListener('mouseup', () => {
            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.style.cursor = 'default';
            }
            if (this.isDraggingImage) {
                this.isDraggingImage = false;
                this.draggedCell = null;
                this.canvas.style.cursor = this.interactionMode === 'image' ? 'grab' : 'default';
            }
        });

        // Wheel (Zoom)
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Punkt pod myszką w układzie "world"
            const worldBefore = this.screenToWorld(mouseX, mouseY);

            // Zmień zoom
            const zoomFactor = 1.15;
            if (e.deltaY < 0) {
                this.zoom *= zoomFactor;
            } else {
                this.zoom /= zoomFactor;
            }
            this.zoom = Math.min(Math.max(this.zoom, 0.1), 4.0);

            // Wylicz nową pozycję pan, aby zachować punkt pod myszką
            const bbox = this.gridManager.getBoundingBoxMm();
            const gridCenterX = bbox.minX + bbox.width / 2;
            const gridCenterY = bbox.minY + bbox.height / 2;

            this.panX = mouseX - this.canvas.width / 2 - (worldBefore.x - gridCenterX) * this.zoom;
            this.panY = mouseY - this.canvas.height / 2 - (worldBefore.y - gridCenterY) * this.zoom;

            this.scheduleRender();
        }, { passive: false });

        // HTML5 Drag & Drop do przeciągania grafik na heksy
        this.canvas.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const world = this.screenToWorld(mouseX, mouseY);
            const hex = HexMath.pixelToAxial(
                world.x, 
                world.y, 
                this.gridManager.config.hexSize, 
                this.gridManager.config.orientation,
                this.gridManager.config.gap,
                this.gridManager.config.stagger || 'left'
            );

            const cell = this.gridManager.getCell(hex.q, hex.r);
            const newKey = (cell && cell.enabled) ? `${hex.q},${hex.r}` : null;

            if (this.hoveredCellKey !== newKey) {
                this.hoveredCellKey = newKey;
                this.scheduleRender();
            }
        });

        this.canvas.addEventListener('dragleave', () => {
            this.hoveredCellKey = null;
            this.scheduleRender();
        });

        this.canvas.addEventListener('drop', e => {
            e.preventDefault();
            
            const imageId = e.dataTransfer.getData('text/plain');
            if (!imageId) return;

            const imageObj = this.imageProcessor.getImage(imageId);
            if (!imageObj) return;

            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const world = this.screenToWorld(mouseX, mouseY);
            const hex = HexMath.pixelToAxial(
                world.x, 
                world.y, 
                this.gridManager.config.hexSize, 
                this.gridManager.config.orientation,
                this.gridManager.config.gap,
                this.gridManager.config.stagger || 'left'
            );

            const cell = this.gridManager.getCell(hex.q, hex.r);
            if (cell && cell.enabled) {
                const imageMode = document.querySelector('input[name="image-mode"]:checked').value;
                if (imageMode === 'multi') {
                    this.imageProcessor.calculateCellCoverCrop(cell, imageObj, this.gridManager);
                    this.scheduleRender();
                    this.canvas.dispatchEvent(new CustomEvent('gridchange'));
                }
            }
            
            this.hoveredCellKey = null;
        });
    }

    /**
     * Główna funkcja renderująca
     */
    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Narysuj tło (szara siatka pomocnicza w tle)
        this.drawBackgroundGrid();

        // Narysuj pełny obraz w tle jeśli wybrano tryb jednej grafiki na całą ścianę i jesteśmy w trybie interakcji kadrowania
        const imageMode = document.querySelector('input[name="image-mode"]:checked')?.value || 'single';
        const imageId = this.imageProcessor.activeImageId;
        const imageObj = imageId ? this.imageProcessor.getImage(imageId) : null;
        const bbox = this.gridManager.getBoundingBoxMm();

        if (bbox.width > 0 && bbox.height > 0 && imageMode === 'single' && imageObj && this.interactionMode === 'image') {
            const imgWidth = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.width : imageObj.width;
            const imgHeight = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.height : imageObj.height;
            const imgAspect = imgWidth / imgHeight;
            const gridAspect = bbox.width / bbox.height;

            let scale;
            if (imgAspect > gridAspect) {
                scale = imgHeight / bbox.height;
            } else {
                scale = imgWidth / bbox.width;
            }

            const zoomFactor = this.gridManager.config.singleImageScale || 1.0;
            const effectiveScale = scale / zoomFactor;

            const gridWidthPx = bbox.width * effectiveScale;
            const gridHeightPx = bbox.height * effectiveScale;

            const offsetX = (imgWidth - gridWidthPx) / 2;
            const offsetY = (imgHeight - gridHeightPx) / 2;

            const shiftX = this.gridManager.config.singleImageOffsetX || 0;
            const shiftY = this.gridManager.config.singleImageOffsetY || 0;

            const screenPos = this.worldToScreen(
                bbox.minX + shiftX - offsetX / effectiveScale,
                bbox.minY + shiftY - offsetY / effectiveScale
            );
            const drawW = (imgWidth / effectiveScale) * this.zoom;
            const drawH = (imgHeight / effectiveScale) * this.zoom;

            const sourceElement = this.imageProcessor.getRotatedCanvasOrImage(imageObj);
            this.ctx.save();
            this.ctx.globalAlpha = 0.35; // Przyciemnione tło
            this.ctx.drawImage(sourceElement, screenPos.x, screenPos.y, drawW, drawH);
            this.ctx.restore();
        }

        const cells = this.gridManager.getAllCells();
        const hexSize = this.gridManager.config.hexSize;
        const orientation = this.gridManager.config.orientation;
        const gap = this.gridManager.config.gap;

        // Pobierz wymiary fizyczne jednego heksa
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);

        // 1. Rysuj nieaktywne komórki najpierw (pod spodem)
        cells.forEach(cell => {
            if (!cell.enabled) {
                this.drawCell(cell, hexSize, orientation, gap, hexDim);
            }
        });

        // 2. Rysuj aktywne komórki
        cells.forEach(cell => {
            if (cell.enabled) {
                this.drawCell(cell, hexSize, orientation, gap, hexDim);
            }
        });

        // 3. Rysuj ramki/obwoluty dookoła jeśli są włączone i aktywny podgląd (opcjonalnie)
        // W trybie planowania pokazujemy tylko zarys heksów i ewentualnie szczelinę.
    }

    /**
     * Rysuje pojedynczy heksagon
     */
    drawCell(cell, hexSize, orientation, gap, hexDim) {
        const stagger = this.gridManager.config.stagger || 'left';
        const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        
        // Przelicz na ekran
        const screenPos = this.worldToScreen(posMm.x, posMm.y);
        const screenHexSize = hexSize * this.zoom;

        const vertices = HexMath.getHexVertices(screenPos.x, screenPos.y, screenHexSize, orientation);

        this.ctx.save();

        if (cell.enabled) {
            // Czy komórka ma przypisany obraz?
            if (cell.imageId && this.imageProcessor.getImage(cell.imageId)) {
                const imageObj = this.imageProcessor.getImage(cell.imageId);
                
                // Przytnij do heksagonu
                this.ctx.beginPath();
                vertices.forEach((v, idx) => {
                    if (idx === 0) this.ctx.moveTo(v.x, v.y);
                    else this.ctx.lineTo(v.x, v.y);
                });
                this.ctx.closePath();
                this.ctx.clip();

                // Narysuj wykadrowany fragment
                const crop = cell.cropRegion;
                const drawW = hexDim.width * this.zoom;
                const drawH = hexDim.height * this.zoom;
                const sourceElement = this.imageProcessor.getRotatedCanvasOrImage(imageObj);

                if (crop) {
                    this.ctx.drawImage(
                        sourceElement,
                        crop.x, crop.y, crop.w, crop.h,
                        screenPos.x - drawW / 2, screenPos.y - drawH / 2,
                        drawW, drawH
                    );
                } else {
                    this.ctx.drawImage(
                        sourceElement,
                        screenPos.x - drawW / 2, screenPos.y - drawH / 2,
                        drawW, drawH
                    );
                }
            } else {
                // Aktywna komórka, ale bez obrazka (lub brak obrazka w pamięci)
                this.ctx.fillStyle = 'rgba(0, 229, 255, 0.08)';
                this.ctx.beginPath();
                vertices.forEach((v, idx) => {
                    if (idx === 0) this.ctx.moveTo(v.x, v.y);
                    else this.ctx.lineTo(v.x, v.y);
                });
                this.ctx.closePath();
                this.ctx.fill();
            }

            // Rysuj obrys aktywnego heksa
            if (cell.exceedsBedSize) {
                this.ctx.strokeStyle = '#ff1744'; // Czerwony dla zbyt dużego elementu
                this.ctx.lineWidth = 2.5;
                this.ctx.setLineDash([4, 4]); // Przerywana linia
            } else {
                this.ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
                this.ctx.lineWidth = 1.5;
            }
            this.ctx.beginPath();
            vertices.forEach((v, idx) => {
                if (idx === 0) this.ctx.moveTo(v.x, v.y);
                else this.ctx.lineTo(v.x, v.y);
            });
            this.ctx.closePath();
            this.ctx.stroke();
            this.ctx.setLineDash([]); // Reset dash

            // Rysuj czerwony nakładkowy filtr, jeśli przekracza stół
            if (cell.exceedsBedSize) {
                this.ctx.fillStyle = 'rgba(255, 23, 68, 0.12)';
                this.ctx.beginPath();
                vertices.forEach((v, idx) => {
                    if (idx === 0) this.ctx.moveTo(v.x, v.y);
                    else this.ctx.lineTo(v.x, v.y);
                });
                this.ctx.closePath();
                this.ctx.fill();
            }

            // Czy to komórka nad którą stoi kursor?
            const isHovered = (this.hoveredCellKey === `${cell.q},${cell.r}`);
            if (isHovered) {
                this.ctx.strokeStyle = '#00e5ff';
                this.ctx.lineWidth = 3;
                this.ctx.shadowColor = 'rgba(0, 229, 255, 0.8)';
                this.ctx.shadowBlur = 8;
                this.ctx.beginPath();
                vertices.forEach((v, idx) => {
                    if (idx === 0) this.ctx.moveTo(v.x, v.y);
                    else this.ctx.lineTo(v.x, v.y);
                });
                this.ctx.closePath();
                this.ctx.stroke();
            }

            // Resetuj shadow przed rysowaniem tekstu
            this.ctx.shadowBlur = 0;

            // Rysuj etykietę (np. A1, A2)
            this.ctx.fillStyle = '#ffffff';
            this.ctx.font = `bold ${Math.max(10, Math.min(14, 12 * this.zoom))}px 'Inter', sans-serif`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            
            // Tło pod tekstem dla czytelności nad grafiką
            const text = cell.label;
            const textWidth = this.ctx.measureText(text).width;
            this.ctx.fillStyle = 'rgba(10, 12, 16, 0.7)';
            this.ctx.fillRect(screenPos.x - textWidth/2 - 4, screenPos.y - 8, textWidth + 8, 16);
            
            this.ctx.fillStyle = '#00e5ff';
            this.ctx.fillText(text, screenPos.x, screenPos.y);

        } else {
            // Nieaktywna komórka (szary dashed outline)
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            this.ctx.setLineDash([5, 5]);
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            vertices.forEach((v, idx) => {
                if (idx === 0) this.ctx.moveTo(v.x, v.y);
                else this.ctx.lineTo(v.x, v.y);
            });
            this.ctx.closePath();
            this.ctx.stroke();
            this.ctx.setLineDash([]); // reset

            // Delikatny tekst typu "-" w środku
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
            this.ctx.font = `${Math.max(8, 10 * this.zoom)}px monospace`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(cell.label, screenPos.x, screenPos.y);
        }

        this.ctx.restore();
    }

    /**
     * Rysuje siatkę kropek lub cienkich linii w tle, aby ułatwić orientację
     */
    drawBackgroundGrid() {
        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        this.ctx.lineWidth = 1;

        const size = 50;
        const width = this.canvas.width;
        const height = this.canvas.height;

        // Prosta siatka kwadratowa jako tło tablicy
        for (let x = this.panX % size; x < width; x += size) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height);
            this.ctx.stroke();
        }

        for (let y = this.panY % size; y < height; y += size) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();
        }

        this.ctx.restore();
    }
}

export default WallPlanner;
