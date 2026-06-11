import FrameGenerator from './js/frame-generator.js';

const mockGridManager = {
    config: {
        hexSize: 100,
        orientation: 'flat-top',
        gap: 2,
        dpi: 300
    },
    getCell() { return null; }
};

const mockCell = {
    label: 'A1',
    q: 0,
    r: 0,
    enabled: true
};

const frameTypes = ['outline', 'backing', 'sleeve'];

try {
    // Mock standard browser document for createFrameCanvas (since canvas is a browser API)
    global.document = {
        createElement(tag) {
            if (tag === 'canvas') {
                return {
                    width: 100,
                    height: 100,
                    getContext() {
                        return {
                            save() {},
                            restore() {},
                            beginPath() {},
                            closePath() {},
                            moveTo() {},
                            lineTo() {},
                            fill() {},
                            stroke() {},
                            fillRect() {},
                            fillStyle: '',
                            strokeStyle: '',
                            lineWidth: 1
                        };
                    }
                };
            }
            return {};
        }
    };

    for (const ft of frameTypes) {
        console.log(`Test: Typ ramy = ${ft}`);
        
        // 1. Test Canvas generation
        const canvas = FrameGenerator.createFrameCanvas(mockCell, mockGridManager, ft, 4, 0.2, '#1a1a1a');
        if (!canvas) throw new Error(`Błąd generowania Canvas dla ${ft}`);
        
        // 2. Test SVG generation
        const svg = FrameGenerator.createFrameSVG(mockCell, mockGridManager, ft, 4, 0.2, '#1a1a1a');
        if (!svg || svg.length === 0) throw new Error(`Pusty SVG dla ${ft}`);
        if (!svg.includes('<svg') || !svg.includes('</svg>')) throw new Error(`Niepoprawny format SVG dla ${ft}`);

        // 3. Test STL generation
        const stl = FrameGenerator.generateFrameSTL(mockCell, mockGridManager, ft, 4, 0.2, 10.0, 1.2);
        if (!stl || stl.length === 0) throw new Error(`Pusty STL dla ${ft}`);
        if (!stl.includes('solid') || !stl.includes('endsolid')) throw new Error(`Niepoprawny format STL dla ${ft}`);
        console.log(`STL ${ft} wygenerowany poprawnie, rozmiar: ${stl.length} znaków.`);
    }
    console.log("Wszystkie typy ramek (Canvas, SVG i STL) przetestowane pomyślnie! Brak błędów logicznych.");
} catch (err) {
    console.error("WYKRYTO BŁĄD PODCZAS GENEROWANIA RAMEK:", err);
    process.exit(1);
}
