import FrameGenerator from './js/frame-generator.js';
import ExportManager from './js/export-manager.js';

// 1. Mockowanie środowiska DOM przeglądarki
global.document = {
    createElement(tag) {
        if (tag === 'canvas') {
            return {
                width: 100,
                height: 100,
                getContext(type) {
                    return {
                        save() {},
                        restore() {},
                        beginPath() {},
                        closePath() {},
                        moveTo() {},
                        lineTo() {},
                        fill() {},
                        stroke() {},
                        arc() {},
                        fillRect() {},
                        clearRect() {},
                        drawImage() {},
                        fillStyle: '',
                        strokeStyle: '',
                        lineWidth: 1,
                        globalCompositeOperation: '',
                        setLineDash() {}
                    };
                },
                toBlob(callback) {
                    callback(new MockBlob(['png_data'], { type: 'image/png' }));
                }
            };
        }
        return {};
    },
    getElementById(id) {
        switch (id) {
            case 'frame-enable': return { checked: true };
            case 'frame-type': return { value: 'outline' };
            case 'frame-width': return { value: '4' };
            case 'frame-clearance': return { value: '0.2' };
            case 'frame-height': return { value: '10' };
            case 'frame-sleeve-base': return { value: '1.2' };
            case 'frame-color': return { value: '#1a1a1a' };
            case 'frame-joint-type': return { value: 'dovetail' };
            case 'chk-export-png': return { checked: true };
            case 'chk-export-svg': return { checked: true };
            case 'chk-export-stl': return { checked: true };
            case 'export-progress-wrapper': return { classList: { add() {}, remove() {} } };
            case 'export-progress-fill': return { style: { width: '0%' } };
            case 'export-progress-text': return { textContent: '' };
            default:
                console.log(`[DOM Mock] Żądanie nieznanego elementu: ${id}`);
                return null;
        }
    }
};

// 2. Mockowanie zewnętrznych bibliotek globalnych
global.JSZip = class {
    constructor() {
        this.files = {};
    }
    file(name, data) {
        this.files[name] = data;
        const len = typeof data === 'string' ? data.length : '[Binary Blob]';
        console.log(`  -> Dodano do ZIP: ${name} (${len} znaków)`);
    }
    generateAsync() {
        return Promise.resolve("mock_zip_binary_blob");
    }
};

global.saveAs = (content, filename) => {
    console.log(`[FileSaver] Pomyślnie wywołano saveAs dla pliku: ${filename}`);
};

global.alert = (msg) => {
    console.log(`[ALERT]: ${msg}`);
};

// 3. Mockowanie GridManagera i komórki
const mockGridManager = {
    config: {
        hexSize: 100,
        orientation: 'flat-top',
        gap: 2,
        dpi: 'original',
        exportFormat: 'jpg',
        exportQuality: 0.8
    },
    getActiveCells() {
        return [
            { label: 'A1', q: 0, r: 0, enabled: true, imageId: 'img_123', cropRegion: { x: 10, y: 10, w: 200, h: 173 } },
            { label: 'B1', q: 1, r: 0, enabled: true, imageId: 'img_456', cropRegion: { x: 210, y: 10, w: 200, h: 173 } }
        ];
    },
    getCell() {
        return null;
    }
};

const mockImageProcessor = {
    // Canvas mock dla eksportu (toBlob)
    createHexagonCanvas(cell, gridManager) {
        return {
            width: 200,
            height: 173,
            toBlob(callback, type, quality) {
                console.log(`  -> Generowanie toBlob dla heksu (Typ: ${type}, Jakość: ${quality})`);
                callback(new MockBlob(['jpg_data'], { type }));
            }
        };
    }
};

// Polifill dla klasy Blob w Node
class MockBlob {
    constructor(parts, options) {
        this.parts = parts;
        this.options = options;
        this.size = 0;
    }
}
global.Blob = MockBlob;

// Uruchomienie testu
async function runTest() {
    console.log("Inicjalizacja ExportManagera...");
    const exporter = new ExportManager(mockGridManager, mockImageProcessor);
    
    console.log("\n--- TEST 1: exportFrameSTL() ---");
    await exporter.exportFrameSTL();

    console.log("\n--- TEST 2: exportHexesZip() z formatem 'jpg' i jakością 80% ---");
    await exporter.exportHexesZip();

    console.log("\n--- TEST 3: exportHexesZip() z formatem 'png' ---");
    mockGridManager.config.exportFormat = 'png';
    await exporter.exportHexesZip();
    
    console.log("\nTesty zakończone pomyślnie!");
}

runTest().catch(err => {
    console.error("BŁĄD KATASTROFALNY TESTU:", err);
    process.exit(1);
});
