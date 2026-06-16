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
     * Zmienia rotację obrazu na określony kąt w stopniach (0-360)
     * @param {string} id - ID obrazu
     * @param {number} angle - kąt obrotu w stopniach (0-360)
     */
    rotateImage(id, angle = 0) {
        const imageObj = this.getImage(id);
        if (!imageObj) return null;

        let targetRotation = angle % 360;
        if (targetRotation < 0) targetRotation += 360;

        imageObj.rotation = targetRotation;

        // Zaktualizuj buforowany obrócony canvas
        if (targetRotation === 0) {
            imageObj.rotatedCanvas = null;
        } else {
            const rad = (targetRotation * Math.PI) / 180;
            const cos = Math.abs(Math.cos(rad));
            const sin = Math.abs(Math.sin(rad));

            const newWidth = Math.round(imageObj.width * cos + imageObj.height * sin);
            const newHeight = Math.round(imageObj.width * sin + imageObj.height * cos);

            const canvas = document.createElement('canvas');
            canvas.width = newWidth;
            canvas.height = newHeight;

            const ctx = canvas.getContext('2d');
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate(rad);
            ctx.drawImage(imageObj.imgElement, -imageObj.width / 2, -imageObj.height / 2);
            imageObj.rotatedCanvas = canvas;
        }

        return imageObj;
    }

    /**
     * Zwraca obrócony canvas lub oryginalny element obrazu
     */
    getRotatedCanvasOrImage(imageObj) {
        if (!imageObj) return null;
        return imageObj.rotatedCanvas || imageObj.imgElement;
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

        const imgWidth = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.width : imageObj.width;
        const imgHeight = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.height : imageObj.height;

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

        // Zastosuj współczynnik powiększenia obrazu (zoomFactor) z właściwości obrazu
        const zoomFactor = imageObj.zoom || 1.0;
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
     * Mapuje pojedynczy obraz na grupę heksów (tryb "span")
     * Oblicza regiony kadrowania dla każdej komórki w grupie.
     */
    recalculateGroupImageMapping(gridManager, groupCells, imageId, zoomFactor = 1.0, shiftX = 0, shiftY = 0) {
        if (!imageId || !groupCells || groupCells.length === 0) return;

        const imageObj = this.getImage(imageId);
        if (!imageObj) return;

        const bbox = gridManager.getBoundingBoxOfCells(groupCells);
        if (bbox.width === 0 || bbox.height === 0) return;

        const imgWidth = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.width : imageObj.width;
        const imgHeight = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.height : imageObj.height;

        const imgAspect = imgWidth / imgHeight;
        const gridAspect = bbox.width / bbox.height;

        let scale; // piksele obrazu na mm grupy siatki
        if (imgAspect > gridAspect) {
            // Obraz jest szerszy niż grupa heksów (dopasowanie do wysokości)
            scale = imgHeight / bbox.height;
        } else {
            // Obraz jest wyższy niż grupa heksów (dopasowanie do szerokości)
            scale = imgWidth / bbox.width;
        }

        const effectiveScale = scale / zoomFactor;

        // Wymiary grupy w pikselach przy efektywnej skali
        const gridWidthPx = bbox.width * effectiveScale;
        const gridHeightPx = bbox.height * effectiveScale;

        // Offset centrujący przy efektywnej skali
        const offsetX = (imgWidth - gridWidthPx) / 2;
        const offsetY = (imgHeight - gridHeightPx) / 2;

        // Clamp shiftX i shiftY tak, aby grupa nie wychodziła poza granice obrazu
        const maxShiftXMm = Math.max(0, offsetX / effectiveScale);
        const maxShiftYMm = Math.max(0, offsetY / effectiveScale);

        const clampedShiftX = Math.max(-maxShiftXMm, Math.min(maxShiftXMm, shiftX));
        const clampedShiftY = Math.max(-maxShiftYMm, Math.min(maxShiftYMm, shiftY));

        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        const gap = gridManager.config.gap;

        // Pobierz wymiary fizyczne jednego heksa
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);

        groupCells.forEach(cell => {
            if (!cell.enabled) return;

            // Środek heksa w układzie siatki (w mm)
            const stagger = gridManager.config.stagger || 'left';
            const pos = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);

            // Oblicz bounding box heksa w mm (względem minX/minY grupy)
            const leftMm = pos.x - hexDim.width / 2 - bbox.minX;
            const topMm = pos.y - hexDim.height / 2 - bbox.minY;

            // Przelicz na piksele w pliku źródłowym (odejmując shiftX / shiftY)
            const x = (leftMm - clampedShiftX) * effectiveScale + offsetX;
            const y = (topMm - clampedShiftY) * effectiveScale + offsetY;
            const w = hexDim.width * effectiveScale;
            const h = hexDim.height * effectiveScale;

            cell.imageId = imageId;
            cell.cropRegion = { x, y, w, h };
            cell.groupShiftX = clampedShiftX;
            cell.groupShiftY = clampedShiftY;
            cell.groupZoom = zoomFactor;
        });
    }

    /**
     * Mapuje pojedynczy obraz do pojedynczego heksu (dopasowanie Cover)
     */
    calculateCellCoverCrop(cell, imageObj, gridManager) {
        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);
        const imgWidth = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.width : imageObj.width;
        const imgHeight = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.height : imageObj.height;

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

        // Zastosuj zoom (skala od 1.0 w górę)
        const scale = imageObj.zoom || 1.0;
        const zoomedW = w / scale;
        const zoomedH = h / scale;
        
        // Wycentruj pomniejszony kadr
        x = x + (w - zoomedW) / 2;
        y = y + (h - zoomedH) / 2;

        cell.imageId = imageObj.id;
        cell.cropRegion = { x, y, w: zoomedW, h: zoomedH };
    }

    /**
     * Tworzy przycięty canvas dla konkretnego heksu (z przezroczystością)
     * @param {CellState} cell - Stan komórki heksagonalnej
     * @param {GridManager} gridManager - Konfiguracja siatki
     * @returns {HTMLCanvasElement|null}
     */
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
        const gap = gridManager.config.gap;
        const stagger = gridManager.config.stagger || 'left';
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);
        const crop = cell.cropRegion;

        let pixelScale;
        if (dpi === 'original' && crop) {
            pixelScale = crop.w / hexDim.width;
        } else {
            if (dpi === 'original') dpi = 300;
            pixelScale = HexMath.mmToPixels(1, dpi);
        }

        const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        
        // Pobierz wierzchołki w skali mm (bez DPI) z uwzględnieniem obcinania
        const verticesMm = HexMath.getCellVertices(cell, gridManager.config);
        
        if (verticesMm.length === 0) return null;

        // Oblicz bounding box wierzchołków w mm
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        verticesMm.forEach(v => {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        });

        const wMm = maxX - minX;
        const hMm = maxY - minY;

        const canvasW = Math.round(wMm * pixelScale);
        const canvasH = Math.round(hMm * pixelScale);

        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;

        const ctx = canvas.getContext('2d');

        // 1. Narysuj hexagonalną/wielokątną ścieżkę cięcia
        ctx.beginPath();
        verticesMm.forEach((v, idx) => {
            const pxX = (v.x - minX) * pixelScale;
            const pxY = (v.y - minY) * pixelScale;
            if (idx === 0) ctx.moveTo(pxX, pxY);
            else ctx.lineTo(pxX, pxY);
        });
        ctx.closePath();
        ctx.clip();

        // 2. Wytnij odpowiedni fragment obrazu i narysuj go na wyjściowym canvasie
        const sourceElement = this.getRotatedCanvasOrImage(imageObj);
        if (crop) {
            // Oblicz przesunięcie w mm względem lewego-górnego rogu unclipped heksa
            const offsetXMm = minX - (posMm.x - hexDim.width / 2);
            const offsetYMm = minY - (posMm.y - hexDim.height / 2);
            
            // Przelicz skale pikseli obrazu źródłowego na mm
            const imgPixelScaleX = crop.w / hexDim.width;
            const imgPixelScaleY = crop.h / hexDim.height;
            
            const sourceX = crop.x + offsetXMm * imgPixelScaleX;
            const sourceY = crop.y + offsetYMm * imgPixelScaleY;
            const sourceW = wMm * imgPixelScaleX;
            const sourceH = hMm * imgPixelScaleY;

            ctx.drawImage(
                sourceElement,
                sourceX, sourceY, sourceW, sourceH, // Skąd (z obrazu źródłowego)
                0, 0, canvasW, canvasH           // Dokąd (na cały wyjściowy canvas)
            );
        } else {
            // Failsafe: cover fit
            ctx.drawImage(sourceElement, 0, 0, canvasW, canvasH);
        }

        return canvas;
    }
}

export default ImageProcessor;
