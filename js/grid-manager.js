import HexMath from './hex-math.js';

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
    }

    /**
     * Inicjalizuje nową siatkę na podstawie konfiguracji
     */
    generateGrid() {
        const oldCells = new Map(this.cells);
        this.cells.clear();

        const { columns, rows, orientation } = this.config;

        for (let col = 0; col < columns; col++) {
            for (let row = 0; row < rows; row++) {
                // Oblicz axialne współrzędne na podstawie wiersza/kolumny
                let q, r;
                if (orientation === 'flat-top') {
                    q = col;
                    r = row - Math.floor(col / 2);
                } else {
                    q = col - Math.floor(row / 2);
                    r = row;
                }

                const key = `${q},${r}`;
                const label = this.getCellLabel(col, row);

                // Zachowaj stan przypisania grafiki jeśli heks już istniał
                if (oldCells.has(key)) {
                    const prev = oldCells.get(key);
                    this.cells.set(key, {
                        ...prev,
                        col,
                        row,
                        label // Odśwież etykietę
                    });
                } else {
                    this.cells.set(key, {
                        q,
                        r,
                        col,
                        row,
                        label,
                        enabled: true,
                        imageId: null, // ID grafiki w ImageProcessor
                        cropRegion: null // Wycięty obszar {x, y, w, h}
                    });
                }
            }
        }
        
        // Weryfikacja wymiarów stołu drukarki dla heksów
        this.checkBedSizeFit();
    }

    /**
     * Generuje czytelną etykietę szachownicową (np. A1, B3, AA2)
     */
    getCellLabel(col, row) {
        let temp = col;
        let letter = '';
        while (temp >= 0) {
            letter = String.fromCharCode((temp % 26) + 65) + letter;
            temp = Math.floor(temp / 26) - 1;
        }
        return `${letter}${row + 1}`;
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
     * Włącza/wyłącza komórkę
     */
    toggleCell(q, r) {
        const key = `${q},${r}`;
        const cell = this.cells.get(key);
        if (cell) {
            cell.enabled = !cell.enabled;
            // Jeśli wyłączamy komórkę, resetujemy jej przypisania
            if (!cell.enabled) {
                cell.imageId = null;
                cell.cropRegion = null;
            }
            return true;
        }
        return false;
    }

    /**
     * Ustawia status wszystkich komórek na raz
     */
    setAllCellsStatus(enabled) {
        for (const cell of this.cells.values()) {
            cell.enabled = enabled;
            if (!enabled) {
                cell.imageId = null;
                cell.cropRegion = null;
            }
        }
    }

    /**
     * Aktualizuje konfigurację siatki
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.generateGrid();
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
        }
    }

    /**
     * Oblicza całkowite fizyczne wymiary siatki w mm
     * Zwraca { width: mm, height: mm, minX: px, minY: px, maxX: px, maxY: px }
     */
    getBoundingBoxMm() {
        const activeCells = this.getActiveCells();
        if (activeCells.length === 0) return { width: 0, height: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;

        // Przejdź po wszystkich aktywnych heksach
        activeCells.forEach(cell => {
            // Pobierz wierzchołki w skali mm (bez DPI) z uwzględnieniem ewentualnego obcinania
            const vertices = HexMath.getCellVertices(cell, this.config);

            vertices.forEach(v => {
                if (v.x < minX) minX = v.x;
                if (v.x > maxX) maxX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.y > maxY) maxY = v.y;
            });
        });

        const width = maxX - minX;
        const height = maxY - minY;

        return {
            width,
            height,
            minX,
            minY,
            maxX,
            maxY
        };
    }

    /**
     * Sprawdza, czy pojedynczy heks (z uwzględnieniem ramki) mieści się na stole drukarki
     */
    checkBedSizeFit() {
        const { hexSize, orientation, bedX, bedY, bedVerify, frameEnable, frameWidth, frameClearance } = this.config;
        
        if (!bedVerify) {
            for (const cell of this.cells.values()) {
                cell.exceedsBedSize = false;
            }
            return;
        }

        // Zewnętrzny rozmiar heksa (circumradius)
        let outerSize = hexSize;
        if (frameEnable) {
            outerSize = hexSize + frameClearance + frameWidth;
        }

        // Wymiary bounding boxa pojedynczego heksa
        const dim = HexMath.getHexDimensions(outerSize, orientation);
        const w = dim.width;
        const h = dim.height;

        // Pasuje jeśli mieści się wprost lub obrócony o 90 stopni
        const fits = (w <= bedX && h <= bedY) || (h <= bedX && w <= bedY);

        for (const cell of this.cells.values()) {
            cell.exceedsBedSize = !fits;
        }
    }
}

export default GridManager;
