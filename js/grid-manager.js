import HexMath from './hex-math.js';
import FrameGenerator from './frame-generator.js';
import { defaultPanelExport } from './panel-groups.js';
import {
    MAX_GRID_CELLS, canStoreCoordinate, cellKey, cellLabel, getGridExtent,
    isGridExtentValid, starterCoordinates, toAxial, toOffset
} from './grid-topology.js';

class GridManager {
    constructor() {
        this.config = {
            columns: 4,
            rows: 3,
            hexSize: 100, // circumradius w mm
            orientation: 'flat-top',
            stagger: 'left', // rozpoczęcie: left (standard) lub right
            gap: 2, // szczelina w mm
            dpi: 300, // DPI dla eksportu
            exportFormat: 'png', // format eksportu: png, jpg
            exportQuality: 0.9, // jakość JPEG (0.1 - 1.0)
            bedX: 256, // stół X w mm
            bedY: 256, // stół Y w mm
            bedVerify: true, // czy weryfikować rozmiar stołu
            frameEnable: true, // czy włączone są ramki
            frameWidth: 2, // szerokość ramki w mm
            frameClearance: 0.2, // luz w mm
            singleImageScale: 1.0, // skala obrazu w tle (1.0 = 100%)
            halfHexes: false // czy generować pół-heksy na obrzeżach
        };

        // Mapa przechowująca stan komórek siatki.
        // Klucz: "q,r", Wartość: CellState
        this.cells = new Map();
        this.panelExport = defaultPanelExport();
        this.invalidateGeometry();
    }

    invalidateGeometry() {
        this.polygons = new Map();
        this.bounds = new Map();
        this.extent = null;
        this.imageBounds = null;
    }

    makeCell({ q, r, ...data }) {
        const { col, row } = toOffset(q, r, this.config.orientation);
        return {
            enabled: true, imageId: null, cropRegion: null, ...data,
            q, r, col, row, label: cellLabel(col, row)
        };
    }

    generateGrid() {
        const { columns, rows, orientation } = this.config;
        const previous = this.cells;
        this.cells = new Map(starterCoordinates(columns, rows, orientation).map(({ q, r }) => {
            const key = cellKey(q, r);
            return [key, this.makeCell(previous.get(key) ?? { q, r })];
        }));
        this.invalidateGeometry();
        this.checkBedSizeFit();
    }

    seedGrid(config) {
        this.config = { ...this.config, ...config, topology: 'explicit', halfHexes: false };
        const { columns, rows, orientation } = this.config;
        this.restoreCells(starterCoordinates(columns, rows, orientation));
    }

    restoreCells(cells) {
        this.cells = new Map(cells.map(data => {
            const cell = this.makeCell({ shape: { kind: 'full' }, ...data, enabled: true });
            return [cellKey(cell.q, cell.r), cell];
        }));
        this.invalidateGeometry();
        this.checkBedSizeFit();
    }

    canAddCell(q, r) {
        if (!canStoreCoordinate(q, r, this.config.orientation) || this.cells.size >= MAX_GRID_CELLS || this.getCell(q, r)) return false;
        this.extent ??= getGridExtent(this.cells.values(), this.config.orientation);
        const { col, row } = toOffset(q, r, this.config.orientation);
        const { minCol, maxCol, minRow, maxRow } = this.extent;
        return isGridExtentValid({
            minCol: Math.min(minCol, col), maxCol: Math.max(maxCol, col),
            minRow: Math.min(minRow, row), maxRow: Math.max(maxRow, row)
        });
    }

    getAvailableNeighbors(cell) {
        if (!cell) return [];
        const { orientation, stagger } = this.config;
        return Array.from({ length: 6 }, (_, edge) => {
            const offset = HexMath.getNeighborOffset(edge, orientation, stagger, cell.q, cell.r);
            return this.makeCell({ q: cell.q + offset.q, r: cell.r + offset.r, edge });
        }).filter(({ q, r }) => this.canAddCell(q, r));
    }

    addCell(q, r) {
        if (!this.canAddCell(q, r)) return false;
        this.cells.set(cellKey(q, r), this.makeCell({ q, r, shape: { kind: 'full' } }));
        this.invalidateGeometry();
        this.checkBedSizeFit();
        return true;
    }

    removeCell(q, r) {
        if (!this.cells.delete(cellKey(q, r))) return false;
        this.invalidateGeometry();
        this.checkBedSizeFit();
        return true;
    }

    setCellShape(cell, shape) {
        if (!HexMath.getCellVertices({ ...cell, shape }, this.config).length) return false;
        cell.shape = shape;
        this.invalidateGeometry();
        this.checkBedSizeFit();
        return true;
    }

    getCellVertices(cell) {
        const key = cellKey(cell.q, cell.r);
        if (!this.polygons.has(key)) this.polygons.set(key, HexMath.getCellVertices(cell, this.config));
        return this.polygons.get(key);
    }

    getCellAtPoint(point, candidates) {
        const { hexSize, orientation, gap, stagger } = this.config;
        const origin = HexMath.pixelToAxial(point.x, point.y, hexSize, orientation, gap, stagger);
        const coordinates = [origin];
        for (let edge = 0; edge < 6; edge++) {
            const delta = HexMath.getNeighborOffset(edge, orientation, stagger, origin.q, origin.r);
            coordinates.push({ q: origin.q + delta.q, r: origin.r + delta.r });
        }
        for (const { q, r } of coordinates) {
            const cell = this.getCell(q, r);
            if (cell?.enabled && HexMath.containsPoint(this.getCellVertices(cell), point)) return cell;
            const candidate = candidates?.get(cellKey(q, r));
            if (candidate && HexMath.containsPoint(HexMath.getCellVertices(candidate, this.config), point)) return candidate;
        }
        return null;
    }

    /**
     * Zwraca heksagon pod podanymi współrzędnymi axialnymi q, r
     */
    getCell(q, r) {
        return this.cells.get(`${q},${r}`);
    }

    /**
     * Pobiera listę wszystkich komórek
     */
    getAllCells() {
        return Array.from(this.cells.values());
    }

    /**
     * Pobiera tylko aktywne komórki
     */
    getActiveCells() {
        return this.getAllCells().filter(cell => cell.enabled);
    }

    /**
     * Aktualizuje konfigurację siatki
     */
    updateConfig(newConfig) {
        const previousOrientation = this.config.orientation;
        this.config = { ...this.config, ...newConfig };
        if (this.config.topology !== 'explicit') {
            this.generateGrid();
            return;
        }
        if (this.config.orientation !== previousOrientation) {
            const remap = ({ q, r }) => {
                const { col, row } = toOffset(q, r, previousOrientation);
                return toAxial(col, row, this.config.orientation);
            };
            this.cells = new Map(this.getAllCells().map(cell => {
                const moved = this.makeCell({ ...cell, ...remap(cell) });
                return [cellKey(moved.q, moved.r), moved];
            }));
            for (const group of this.panelExport.groups) group.cells = group.cells.map(remap);
        }
        this.invalidateGeometry();
        this.checkBedSizeFit();
    }

    /**
     * Przypisuje obraz do konkretnego heksu
     */
    assignImageToCell(q, r, imageId, cropRegion = null) {
        const cell = this.getCell(q, r);
        if (cell && cell.enabled) {
            cell.imageId = imageId;
            cell.cropRegion = cropRegion;
            return true;
        }
        return false;
    }

    /**
     * Czyści przypisania obrazów we wszystkich komórkach
     */
    clearImageAssignments() {
        for (const cell of this.cells.values()) {
            cell.imageId = null;
            cell.cropRegion = null;
            cell.groupId = null;
            cell.groupShiftX = null;
            cell.groupShiftY = null;
            cell.groupZoom = null;
        }
    }

    /**
     * Oblicza całkowite fizyczne wymiary siatki w mm
     * Zwraca { width: mm, height: mm, minX: px, minY: px, maxX: px, maxY: px }
     */
    getBoundingBoxMm(gap = this.config.gap) {
        if (!this.bounds.has(gap)) {
            this.bounds.set(gap, this.getBoundingBoxOfCells(this.getActiveCells(), gap));
        }
        return this.bounds.get(gap);
    }

    getImageBounds(cells) {
        if (cells) return this.getBoundingBoxOfCells(cells, this.config.gap, true);
        this.imageBounds ??= this.getBoundingBoxOfCells(this.getActiveCells(), this.config.gap, true);
        return this.imageBounds;
    }

    getBoundingBoxOfCells(cells, gap = this.config.gap, forImage = false) {
        const vertices = [];
        for (const cell of cells ?? []) {
            const shift = HexMath.getGapTranslation(cell, this.config, gap);
            // A manual cut masks the image without changing its coordinate system.
            const polygon = forImage && cell.shape?.kind === 'cuts'
                ? HexMath.getCellVertices({ ...cell, shape: { kind: 'full' } }, this.config)
                : this.getCellVertices(cell);
            for (const point of polygon) {
                vertices.push({ x: point.x + shift.x, y: point.y + shift.y });
            }
        }
        return HexMath.getPolygonBounds(vertices);
    }

    /**
     * Sprawdza, czy pojedynczy heks (z uwzględnieniem ramki) mieści się na stole drukarki
     */
    checkBedSizeFit() {
        const { bedX, bedY, bedVerify, frameEnable, frameWidth, frameClearance } = this.config;
        
        if (!bedVerify) {
            for (const cell of this.cells.values()) {
                cell.exceedsBedSize = false;
            }
            return;
        }

        for (const cell of this.cells.values()) {
            let vertices;
            if (frameEnable) {
                const frame = FrameGenerator.getFrameVerticesMm(cell, this, frameWidth, frameClearance);
                vertices = frame.outerVerticesMm;
            } else {
                vertices = this.getCellVertices(cell);
            }

            if (!vertices || vertices.length < 3 || ![bedX, bedY].every(value => Number.isFinite(value) && value > 0)) {
                cell.exceedsBedSize = true;
                continue;
            }

            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const vertex of vertices) {
                minX = Math.min(minX, vertex.x);
                maxX = Math.max(maxX, vertex.x);
                minY = Math.min(minY, vertex.y);
                maxY = Math.max(maxY, vertex.y);
            }
            const width = maxX - minX;
            const height = maxY - minY;
            cell.exceedsBedSize = !((width <= bedX && height <= bedY) || (height <= bedX && width <= bedY));
        }
    }
}

export default GridManager;
