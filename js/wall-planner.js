import HexMath from './hex-math.js?v=1.0.3';
import { cellKey } from './grid-topology.js';

class WallPlanner {
    constructor(canvasId, gridManager, imageProcessor) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.gridManager = gridManager;
        this.imageProcessor = imageProcessor;

        // Stan widoku (Pan & Zoom)
        this.zoom = 1.0;
        this.fitView = true;
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
        this.interactionMode = 'grid'; // 'grid' | 'image' | 'groups'
        this.isDraggingImage = false;
        this.draggedCell = null;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.renderRequested = false;
        this.renderTransform = null;
        this.selectedCellKey = null;
        this.pendingTouch = null;

        this.initEvents();
        this.resizeObserver = new ResizeObserver(() => {
            if (this.canvas.parentElement.clientWidth) this.resize();
        });
        this.resizeObserver.observe(this.canvas.parentElement);
    }

    /**
     * Zleca renderowanie w kolejnej klatce animacji (requestAnimationFrame)
     */
    scheduleRender() {
        if (this.renderRequested) return;
        this.renderRequested = true;
        requestAnimationFrame(() => {
            this.renderRequested = false;
            this.render();
        });
    }

    resize() {
        const wrapper = this.canvas.parentElement;
        if (this.canvas.width === wrapper.clientWidth && this.canvas.height === wrapper.clientHeight) return;
        this.canvas.width = wrapper.clientWidth;
        this.canvas.height = wrapper.clientHeight;
        if (this.fitView) this.centerGrid();
        else if (this.getSelectedCell()) this.revealCell(this.getSelectedCell());
        this.scheduleRender();
    }

    centerGrid() {
        this.fitView = true;
        const bbox = this.gridManager.getBoundingBoxMm();
        if (!bbox.width || !bbox.height || !this.canvas.width || !this.canvas.height) return;
        const corners = [
            { x: bbox.minX, y: bbox.minY },
            { x: bbox.maxX, y: bbox.maxY }
        ];
        const config = this.gridManager.config;
        if (this.interactionMode === 'grid' && this.gridEditor) {
            for (const candidate of this.gridEditor.candidates.values()) {
                corners.push(...HexMath.getCellVertices(candidate, config));
            }
        }
        const fit = HexMath.getPolygonBounds(corners);
        const scaleX = (this.canvas.width - 24) / fit.width;
        const scaleY = (this.canvas.height - 24) / fit.height;
        this.zoom = Math.max(0.005, Math.min(scaleX, scaleY, 4));
        this.panX = (bbox.minX + bbox.width / 2 - fit.minX - fit.width / 2) * this.zoom;
        this.panY = (bbox.minY + bbox.height / 2 - fit.minY - fit.height / 2) * this.zoom;
        this.scheduleRender();
    }

    /**
     * Zamienia współrzędne ekranowe na mm
     */
    screenToWorld(screenX, screenY) {
        const bbox = this.renderTransform?.bbox || this.gridManager.getBoundingBoxMm();
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
        const bbox = this.renderTransform?.bbox || this.gridManager.getBoundingBoxMm();
        const gridCenterX = bbox.minX + bbox.width / 2;
        const gridCenterY = bbox.minY + bbox.height / 2;

        const screenX = (worldX - gridCenterX) * this.zoom + this.canvas.width / 2 + this.panX;
        const screenY = (worldY - gridCenterY) * this.zoom + this.canvas.height / 2 + this.panY;

        return { x: screenX, y: screenY };
    }

    /**
     * Przypisuje grupę komórek do jednego obrazu w trybie span
     */
    assignGroupToCells(targetCells, imageId) {
        if (!targetCells || targetCells.length === 0) return;

        // 1. Znajdź wszystkie stare grupy, które zostaną zmodyfikowane
        const modifiedGroupIds = new Set();
        targetCells.forEach(cell => {
            if (cell.groupId) {
                modifiedGroupIds.add(cell.groupId);
            }
        });

        // 2. Nadaj nowy groupId i imageId dla targetCells
        const newGroupId = 'group_' + Math.random().toString(36).substr(2, 9);
        targetCells.forEach(cell => {
            cell.groupId = newGroupId;
            cell.imageId = imageId;
        });

        // 3. Oblicz mapowanie dla nowej grupy
        const imageObj = this.imageProcessor.getImage(imageId);
        this.imageProcessor.recalculateGroupImageMapping(
            this.gridManager,
            targetCells,
            imageId,
            (imageObj ? imageObj.zoom : 1.0) || 1.0,
            0,
            0
        );

        // 4. Zaktualizuj stare grupy, z których zabraliśmy heksy
        modifiedGroupIds.forEach(oldGroupId => {
            if (oldGroupId === newGroupId) return;
            const remainingCells = this.gridManager.getAllCells().filter(c => c.enabled && c.groupId === oldGroupId);
            if (remainingCells.length > 0) {
                const firstCell = remainingCells[0];
                this.imageProcessor.recalculateGroupImageMapping(
                    this.gridManager,
                    remainingCells,
                    firstCell.imageId,
                    firstCell.groupZoom || 1.0,
                    firstCell.groupShiftX || 0,
                    firstCell.groupShiftY || 0
                );
            }
        });
    }

    getSelectedCell() {
        return this.selectedCellKey ? this.gridManager.cells.get(this.selectedCellKey) ?? null : null;
    }

    getCellAtClientPoint(clientX, clientY, includeCandidates = false) {
        const rect = this.canvas.getBoundingClientRect();
        const point = this.screenToWorld(clientX - rect.left, clientY - rect.top);
        return this.gridManager.getCellAtPoint(point, includeCandidates ? this.gridEditor?.candidates : null);
    }

    selectGridPoint(clientX, clientY) {
        const cell = this.getCellAtClientPoint(clientX, clientY, true);
        if (cell?.edge !== undefined) this.gridEditor?.add(cell.q, cell.r);
        else this.gridEditor?.setSelection(cell);
    }

    handleCanvasKeydown(e) {
        if (e.key === 'Escape') {
            if (this.interactionMode === 'groups') {
                this.panelController?.resetSelection();
                this.panelController?.refresh();
            } else if (this.interactionMode === 'grid') {
                this.gridEditor?.setSelection(null);
            }
            return;
        }
        if (e.key === 'Delete' && this.interactionMode === 'grid') {
            e.preventDefault();
            this.gridEditor?.remove();
            return;
        }

        const current = this.getSelectedCell() ?? this.gridManager.getAllCells()[0];
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (this.interactionMode === 'groups') this.panelController?.selectCell(current);
            else if (this.interactionMode === 'grid') this.gridEditor?.setSelection(current);
            return;
        }

        const directions = {
            ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
        };
        const direction = directions[e.key];
        if (!direction || !current) return;
        e.preventDefault();
        const [dc, dr] = direction;
        let best = null;
        let bestScore = Infinity;
        for (const cell of this.gridManager.cells.values()) {
            const x = cell.col - current.col;
            const y = cell.row - current.row;
            const forward = x * dc + y * dr;
            const lateral = Math.abs(x * dr - y * dc);
            if (forward <= 0) continue;
            const score = forward + 2 * lateral;
            if (score < bestScore) { best = cell; bestScore = score; }
        }
        const target = best ?? current;
        if (this.interactionMode === 'grid') this.gridEditor?.setSelection(target);
        else {
            this.selectedCellKey = `${target.q},${target.r}`;
            this.hoveredCellKey = this.selectedCellKey;
            document.getElementById('planner-live-status').textContent = target.label;
            this.scheduleRender();
        }
        this.revealCell(target);
    }

    revealCell(cell) {
        const polygon = cell.edge === undefined
            ? this.gridManager.getCellVertices(cell)
            : HexMath.getCellVertices(cell, this.gridManager.config);
        const { minX, minY, width, height } = HexMath.getPolygonBounds(polygon);
        const point = this.worldToScreen(minX + width / 2, minY + height / 2);
        const fit = (n, limit) => Math.min(Math.max(n, 24), Math.max(24, limit - 24));
        this.panX += fit(point.x, this.canvas.width) - point.x;
        this.panY += fit(point.y, this.canvas.height) - point.y;
        this.scheduleRender();
    }

    /**
     * Inicjalizuje zdarzenia myszy, dotyku i drag-and-drop
     */
    initEvents() {
        // Blokada prawego przycisku myszy dla przeciągania (pan)
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        // Mousedown / Touchstart
        this.canvas.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch') {
                e.preventDefault();
                this.canvas.setPointerCapture?.(e.pointerId);
                if (this.interactionMode !== 'image') {
                    this.pendingTouch = { x: e.clientX, y: e.clientY, mode: this.interactionMode === 'groups' ? 'group' : 'select' };
                    return;
                }
            }
            if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
                // Środkowy, prawy lub LPM z Shift = Przesuwanie (Pan)
                this.isPanning = true;
                this.fitView = false;
                this.startX = e.clientX - this.panX;
                this.startY = e.clientY - this.panY;
                this.canvas.style.cursor = 'grabbing';
            } else if (e.button === 0) {
                if (this.interactionMode === 'grid') {
                    this.selectGridPoint(e.clientX, e.clientY);
                    return;
                }
                const cell = this.getCellAtClientPoint(e.clientX, e.clientY);
                
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
                    } else if (imageMode === 'span') {
                        // W trybie span przeciągamy obraz w grupie heksów
                        if (cell && cell.enabled && cell.imageId && cell.groupId && cell.cropRegion) {
                            this.isDraggingImage = true;
                            this.draggedCell = cell;
                            this.lastMouseX = e.clientX;
                            this.lastMouseY = e.clientY;
                            this.canvas.style.cursor = 'grabbing';
                        }
                    }
                } else if (this.interactionMode === 'groups') {
                    if (cell) this.panelController?.selectCell(cell);
                }
                if (e.pointerType === 'touch' && !this.isDraggingImage) {
                    this.pendingTouch = { x: e.clientX, y: e.clientY, mode: 'pan' };
                }
            }
        });

        // Pointer movement handles mouse, pen and touch with the same coordinate path.
        this.canvas.addEventListener('pointermove', e => {
            if (this.pendingTouch) {
                const dx = e.clientX - this.pendingTouch.x;
                const dy = e.clientY - this.pendingTouch.y;
                if (Math.hypot(dx, dy) > 8) {
                    this.isPanning = true;
                    this.fitView = false;
                    this.startX = this.pendingTouch.x - this.panX;
                    this.startY = this.pendingTouch.y - this.panY;
                    this.pendingTouch = { ...this.pendingTouch, mode: 'pan' };
                    this.canvas.style.cursor = 'grabbing';
                }
                if (this.isPanning) {
                    this.panX = e.clientX - this.startX;
                    this.panY = e.clientY - this.startY;
                    this.scheduleRender();
                }
                return;
            }
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
                } else if (imageMode === 'span' && this.draggedCell) {
                    // Przesuwanie obrazu w grupie heksów
                    const cell = this.draggedCell;
                    const groupId = cell.groupId;
                    const imageId = cell.imageId;
                    const imageObj = this.imageProcessor.getImage(imageId);
                    if (imageObj) {
                        const groupCells = this.gridManager.getAllCells().filter(c => c.enabled && c.groupId === groupId);
                        if (groupCells.length > 0) {
                            const currentShiftX = cell.groupShiftX || 0;
                            const currentShiftY = cell.groupShiftY || 0;

                            const newShiftX = currentShiftX + dx / this.zoom;
                            const newShiftY = currentShiftY + dy / this.zoom;

                            const groupZoom = cell.groupZoom || 1.0;

                            this.imageProcessor.recalculateGroupImageMapping(
                                this.gridManager,
                                groupCells,
                                imageId,
                                groupZoom,
                                newShiftX,
                                newShiftY
                            );
                        }
                    }
                }

                this.scheduleRender();
                this.canvas.dispatchEvent(new CustomEvent('gridchange'));
            } else {
                const cell = this.getCellAtClientPoint(e.clientX, e.clientY, this.interactionMode === 'grid');
                const newKey = cell ? `${cell.q},${cell.r}` : null;

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
                    } else if (imageMode === 'span') {
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
        window.addEventListener('pointerup', () => {
            if (this.pendingTouch?.mode === 'select' && this.interactionMode === 'grid') {
                this.selectGridPoint(this.pendingTouch.x, this.pendingTouch.y);
            } else if (this.pendingTouch?.mode === 'group' && this.interactionMode === 'groups') {
                const cell = this.getCellAtClientPoint(this.pendingTouch.x, this.pendingTouch.y);
                if (cell) this.panelController?.selectCell(cell);
            }
            this.pendingTouch = null;
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
        window.addEventListener('pointercancel', () => {
            this.pendingTouch = null;
            this.isPanning = false;
            this.isDraggingImage = false;
            this.draggedCell = null;
            this.canvas.style.cursor = 'default';
        });

        this.canvas.addEventListener('keydown', e => this.handleCanvasKeydown(e));

        // Wheel (Zoom)
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Punkt pod myszką w układzie "world"
            const worldBefore = this.screenToWorld(mouseX, mouseY);

            this.fitView = false;
            const zoomFactor = 1.15;
            if (e.deltaY < 0) {
                this.zoom *= zoomFactor;
            } else {
                this.zoom /= zoomFactor;
            }
            this.zoom = Math.min(Math.max(this.zoom, 0.005), 4.0);

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
            
            const cell = this.getCellAtClientPoint(e.clientX, e.clientY);
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

            const cell = this.getCellAtClientPoint(e.clientX, e.clientY);
            if (cell && cell.enabled) {
                const imageMode = document.querySelector('input[name="image-mode"]:checked').value;
                if (imageMode === 'multi') {
                    this.imageProcessor.calculateCellCoverCrop(cell, imageObj, this.gridManager);
                    this.scheduleRender();
                    this.canvas.dispatchEvent(new CustomEvent('gridchange'));
                } else if (imageMode === 'span') {
                    // Automatyczne grupowanie: znajdujemy wszystkie aktywne heksy z tym samym imageId
                    const existingGroupCells = this.gridManager.getAllCells().filter(c => c.enabled && c.imageId === imageId);
                    
                    // Łączymy je z upuszczonym heksem w jedną tablicę
                    const targetCells = new Set(existingGroupCells);
                    targetCells.add(cell);
                    
                    const targetCellsArray = Array.from(targetCells);
                    
                    this.assignGroupToCells(targetCellsArray, imageId);
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
        // getBoundingBoxMm walks every active cell. Snapshot it once per frame so every
        // vertex projection in this render is constant-time and stays consistent.
        this.renderTransform = { bbox: this.gridManager.getBoundingBoxMm() };
        try {
            this.renderFrame();
        } finally {
            this.renderTransform = null;
        }
    }

    renderFrame() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Narysuj tło (szara siatka pomocnicza w tle)
        this.drawBackgroundGrid();

        // Narysuj pełny obraz w tle jeśli wybrano tryb jednej grafiki na całą ścianę i jesteśmy w trybie interakcji kadrowania
        const imageMode = document.querySelector('input[name="image-mode"]:checked')?.value || 'single';
        const imageId = this.imageProcessor.activeImageId;
        const imageObj = imageId ? this.imageProcessor.getImage(imageId) : null;
        if (imageMode === 'single' && imageObj && this.interactionMode === 'image' && this.gridManager.cells.size) {
            const bbox = this.gridManager.getImageBounds();
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

        const { hexSize, orientation } = this.gridManager.config;
        const nominal = HexMath.getHexDimensions(hexSize, orientation);
        const hoveredGroup = imageMode === 'span'
            ? this.gridManager.cells.get(this.hoveredCellKey)?.groupId : null;
        for (const cell of this.gridManager.getActiveCells()) this.drawCell(cell, nominal, hoveredGroup);
        if (this.interactionMode === 'grid') this.drawNeighbors();
        this.panelController?.drawOverlay(this.ctx);
    }

    drawNeighbors() {
        if (!this.gridEditor?.candidates.size) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.lineWidth = 1.5;
        for (const cell of this.gridEditor.candidates.values()) {
            const config = this.gridManager.config;
            const vertices = HexMath.getCellVertices(cell, config);
            const { x, y } = HexMath.axialToPixel(cell.q, cell.r, config.hexSize, config.orientation, config.gap, config.stagger);
            const center = this.worldToScreen(x, y);
            ctx.beginPath();
            for (const vertex of vertices) {
                const point = this.worldToScreen(vertex.x, vertex.y);
                ctx.lineTo(point.x, point.y);
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(128, 185, 232, 0.12)';
            ctx.fill();
            ctx.strokeStyle = '#80b9e8';
            ctx.setLineDash([5, 4]);
            ctx.stroke();
            ctx.fillStyle = '#b9d9f3';
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('+', center.x, center.y);
        }
        ctx.restore();
    }

    drawCell(cell, nominal, hoveredGroup) {
        const { hexSize, orientation, gap, stagger } = this.gridManager.config;
        const world = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        const center = this.worldToScreen(world.x, world.y);
        const margin = hexSize * this.zoom + 14;
        if (center.x < -margin || center.y < -margin ||
            center.x > this.canvas.width + margin || center.y > this.canvas.height + margin) return;

        const vertices = this.gridManager.getCellVertices(cell);
        if (!vertices.length) return;
        const path = new Path2D();
        let sumX = 0;
        let sumY = 0;
        vertices.forEach((vertex, index) => {
            const { x, y } = this.worldToScreen(vertex.x, vertex.y);
            if (index === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
            sumX += x;
            sumY += y;
        });
        path.closePath();

        const ctx = this.ctx;
        ctx.save();
        const image = this.imageProcessor.getImage(cell.imageId);
        if (image) {
            const source = this.imageProcessor.getRotatedCanvasOrImage(image);
            const width = nominal.width * this.zoom;
            const height = nominal.height * this.zoom;
            const x = center.x - width / 2;
            const y = center.y - height / 2;
            const crop = cell.cropRegion;
            ctx.save();
            ctx.clip(path);
            if (crop) ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, x, y, width, height);
            else ctx.drawImage(source, x, y, width, height);
            ctx.restore();
        } else {
            ctx.fillStyle = 'rgba(128, 185, 232, 0.08)';
            ctx.fill(path);
        }

        ctx.strokeStyle = 'rgba(128, 185, 232, 0.4)';
        ctx.lineWidth = 1.5;
        if (cell.exceedsBedSize) {
            ctx.fillStyle = 'rgba(255, 23, 68, 0.12)';
            ctx.fill(path);
            ctx.strokeStyle = '#ff1744';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([4, 4]);
        }
        ctx.stroke(path);
        ctx.setLineDash([]);

        const key = cellKey(cell.q, cell.r);
        const selected = this.interactionMode === 'grid' && this.selectedCellKey === key;
        if (selected || this.hoveredCellKey === key || (hoveredGroup && cell.groupId === hoveredGroup)) {
            ctx.strokeStyle = '#9dc9ee';
            ctx.lineWidth = 3;
            ctx.stroke(path);
        }

        if (nominal.width * this.zoom >= 18) {
            const x = sumX / vertices.length;
            const y = sumY / vertices.length;
            ctx.font = `bold ${Math.max(10, Math.min(14, 12 * this.zoom))}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const textWidth = ctx.measureText(cell.label).width;
            ctx.fillStyle = 'rgba(10, 12, 16, 0.7)';
            ctx.fillRect(x - textWidth / 2 - 4, y - 8, textWidth + 8, 16);
            ctx.fillStyle = '#9dc9ee';
            ctx.fillText(cell.label, x, y);
        }
        ctx.restore();
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
