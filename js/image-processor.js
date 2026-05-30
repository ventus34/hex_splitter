import HexMath from './hex-math.js';

class ImageProcessor {
    constructor() {
        // Obrazy załadowane przez użytkownika
        // Klucz: id (string), Wartość: { id, name, imgElement, width, height, src }
        this.images = new Map();
        
        // Aktywny obraz dla trybu "single image"
        this.activeImageId = null;
    }

    /**
     * Wczytuje grafikę z pliku i dodaje do biblioteki
     */
    async addImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const id = 'img_' + Math.random().toString(36).substr(2, 9);
                const imageObj = {
                    id,
                    name: file.name,
                    imgElement: img,
                    width: img.width,
                    height: img.height,
                    src: url
                };
                this.images.set(id, imageObj);
                
                // Jeśli to pierwszy obraz, ustaw go jako aktywny
                if (!this.activeImageId) {
                    this.activeImageId = id;
                }
                
                resolve(imageObj);
            };
            img.onerror = (err) => {
                URL.revokeObjectURL(url);
                reject(err);
            };
            img.src = url;
        });
    }

    /**
     * Usuwa grafikę z biblioteki
     */
    removeImage(id) {
        const imgObj = this.images.get(id);
        if (imgObj) {
            if (imgObj.src && imgObj.src.startsWith('blob:')) {
                URL.revokeObjectURL(imgObj.src);
            }
            imgObj.imgElement.src = '';
            imgObj.imgElement = null;
            this.images.delete(id);
        }
        if (this.activeImageId === id) {
            const keys = Array.from(this.images.keys());
            this.activeImageId = keys.length > 0 ? keys[0] : null;
        }
    }

    /**
     * Czyści całą bibliotekę i niszczy obiekty z pamięci
     */
    clearAll() {
        for (const id of this.images.keys()) {
            this.removeImage(id);
        }
        this.activeImageId = null;
    }

    /**
     * Pobiera grafikę o określonym ID
     */
    getImage(id) {
        return this.images.get(id);
    }

    /**
     * Pobiera listę wszystkich załadowanych grafik
     */
    getAllImages() {
        return Array.from(this.images.values());
    }

    /**
     * Mapuje pojedynczy obraz na całą siatkę heksów
     * Oblicza regiony kadrowania (cropRegion) dla każdej komórki
     */
    recalculateSingleImageMapping(gridManager) {
        const imageId = this.activeImageId;
        if (!imageId) return;

        const imageObj = this.getImage(imageId);
        if (!imageObj) return;

        const bbox = gridManager.getBoundingBoxMm();
        if (bbox.width === 0 || bbox.height === 0) return;

        const imgWidth = imageObj.width;
        const imgHeight = imageObj.height;

        const imgAspect = imgWidth / imgHeight;
        const gridAspect = bbox.width / bbox.height;

        let scale; // piksele obrazu na mm siatki
        if (imgAspect > gridAspect) {
            // Obraz jest szerszy niż siatka (dopasowanie do wysokości)
            scale = imgHeight / bbox.height;
        } else {
            // Obraz jest wyższy niż siatka (dopasowanie do szerokości)
            scale = imgWidth / bbox.width;
        }

        // Zastosuj współczynnik powiększenia obrazu (zoomFactor)
        const zoomFactor = gridManager.config.singleImageScale || 1.0;
        const effectiveScale = scale / zoomFactor;

        // Wymiary siatki w pikselach przy efektywnej skali
        const gridWidthPx = bbox.width * effectiveScale;
        const gridHeightPx = bbox.height * effectiveScale;

        // Offset centrujący przy efektywnej skali
        const offsetX = (imgWidth - gridWidthPx) / 2;
        const offsetY = (imgHeight - gridHeightPx) / 2;

        // Przesunięcie (panning) w mm
        let shiftX = gridManager.config.singleImageOffsetX || 0;
        let shiftY = gridManager.config.singleImageOffsetY || 0;

        // Clamp shiftX i shiftY tak, aby siatka nie wychodziła poza granice obrazu.
        // Ograniczamy przesunięcie w danej osi tylko jeśli obraz jest większy niż siatka (offset > 0).
        const maxShiftXMm = Math.max(0, offsetX / effectiveScale);
        const maxShiftYMm = Math.max(0, offsetY / effectiveScale);

        shiftX = Math.max(-maxShiftXMm, Math.min(maxShiftXMm, shiftX));
        shiftY = Math.max(-maxShiftYMm, Math.min(maxShiftYMm, shiftY));

        // Zapisz zclampowane wartości z powrotem do konfiguracji siatki
        gridManager.config.singleImageOffsetX = shiftX;
        gridManager.config.singleImageOffsetY = shiftY;

        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        const gap = gridManager.config.gap;

        // Pobierz wymiary fizyczne jednego heksa
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);

        gridManager.getAllCells().forEach(cell => {
            if (!cell.enabled) return;

            // Środek heksa w układzie siatki (w mm)
            const stagger = gridManager.config.stagger || 'left';
            const pos = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);

            // Oblicz bounding box heksa w mm (względem minX/minY siatki)
            const leftMm = pos.x - hexDim.width / 2 - bbox.minX;
            const topMm = pos.y - hexDim.height / 2 - bbox.minY;

            // Przelicz na piksele w pliku źródłowym (odejmując shiftX / shiftY)
            const x = (leftMm - shiftX) * effectiveScale + offsetX;
            const y = (topMm - shiftY) * effectiveScale + offsetY;
            const w = hexDim.width * effectiveScale;
            const h = hexDim.height * effectiveScale;

            cell.imageId = imageId;
            cell.cropRegion = { x, y, w, h };
        });
    }

    /**
     * Mapuje pojedynczy obraz do pojedynczego heksu (dopasowanie Cover)
     */
    calculateCellCoverCrop(cell, imageObj, gridManager) {
        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);
        const imgWidth = imageObj.width;
        const imgHeight = imageObj.height;

        const cellAspect = hexDim.width / hexDim.height;
        const imgAspect = imgWidth / imgHeight;

        let x = 0, y = 0, w = imgWidth, h = imgHeight;

        if (imgAspect > cellAspect) {
            // Obraz jest szerszy
            w = imgHeight * cellAspect;
            x = (imgWidth - w) / 2;
        } else {
            // Obraz jest wyższy
            h = imgWidth / cellAspect;
            y = (imgHeight - h) / 2;
        }

        cell.imageId = imageObj.id;
        cell.cropRegion = { x, y, w, h };
    }

    /**
     * Tworzy przycięty canvas dla konkretnego heksu (z przezroczystością)
     * @param {CellState} cell - Stan komórki heksagonalnej
     * @param {GridManager} gridManager - Konfiguracja siatki
     * @returns {HTMLCanvasElement|null}
     */
    createHexagonCanvas(cell, gridManager) {
        if (!cell.enabled || !cell.imageId) return null;

        const imageObj = this.getImage(cell.imageId);
        if (!imageObj) return null;

        let dpi = gridManager.config.dpi;
        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;

        // Wymiary heksa w mm
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);

        let canvasW, canvasH, targetHexSize;

        if (dpi === 'original' && cell.cropRegion) {
            // Użyj oryginalnego rozmiaru kadru
            canvasW = Math.round(cell.cropRegion.w);
            canvasH = Math.round(cell.cropRegion.h);
            
            if (orientation === 'flat-top') {
                targetHexSize = canvasW / 2;
            } else {
                targetHexSize = canvasH / 2;
            }
        } else {
            // Jeśli dpi to string "original" ale brak cropRegion, używamy fallbacku 300
            if (dpi === 'original') dpi = 300;
            
            // Przelicz wymiary wyjściowego canvasu na piksele wg DPI
            canvasW = Math.round(HexMath.mmToPixels(hexDim.width, dpi));
            canvasH = Math.round(HexMath.mmToPixels(hexDim.height, dpi));
            targetHexSize = HexMath.mmToPixels(hexSize, dpi);
        }

        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;

        const ctx = canvas.getContext('2d');

        // Środek canvasu
        const cx = canvasW / 2;
        const cy = canvasH / 2;

        // 1. Narysuj hexagonalną ścieżkę cięcia
        ctx.beginPath();
        const vertices = HexMath.getHexVertices(cx, cy, targetHexSize, orientation);
        vertices.forEach((v, idx) => {
            if (idx === 0) ctx.moveTo(v.x, v.y);
            else ctx.lineTo(v.x, v.y);
        });
        ctx.closePath();

        // 2. Zastosuj maskowanie
        ctx.clip();

        // 3. Wytnij odpowiedni fragment obrazu i narysuj go na wyjściowym canvasie
        const crop = cell.cropRegion;
        if (crop) {
            ctx.drawImage(
                imageObj.imgElement,
                crop.x, crop.y, crop.w, crop.h, // Skąd (z obrazu źródłowego)
                0, 0, canvasW, canvasH           // Dokąd (na cały wyjściowy canvas)
            );
        } else {
            // Failsafe: cover fit
            ctx.drawImage(imageObj.imgElement, 0, 0, canvasW, canvasH);
        }

        return canvas;
    }
}

export default ImageProcessor;
