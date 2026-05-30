import HexMath from './hex-math.js?v=1.0.3';

const FrameGenerator = {
    /**
     * Tworzy płótno (canvas) z rysunkiem ramki dla danego heksu z uwzględnieniem złączy
     */
    createFrameCanvas(cell, gridManager, type, widthMm, clearanceMm, color = '#1a1a1a', customDpi = null) {
        const dpi = customDpi || gridManager.config.dpi;
        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        const gap = gridManager.config.gap;

        // Rozmiar wewnętrzny heksa (rozmiar grafiki + tolerancja)
        const innerHexSizeMm = hexSize + clearanceMm;
        // Rzeczywisty maksymalny promień (circumradius) zewnętrznego heksu
        // po odsunięciu krawędzi o widthMm na zewnątrz (r = R * cos(30 deg))
        const maxOuterHexSizeMm = innerHexSizeMm + widthMm / Math.cos(Math.PI / 6);

        // Bounding box zewnętrznego heksa w mm
        const outerDim = HexMath.getHexDimensions(maxOuterHexSizeMm, orientation);

        // Przeliczenie na piksele wyjściowe
        const canvasW = Math.round(HexMath.mmToPixels(outerDim.width, dpi));
        const canvasH = Math.round(HexMath.mmToPixels(outerDim.height, dpi));

        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;

        const ctx = canvas.getContext('2d');
        const cx = canvasW / 2;
        const cy = canvasH / 2;

        const innerSizePx = HexMath.mmToPixels(innerHexSizeMm, dpi);

        // Ustalenie offsetów dla każdego boku
        const isDummy = !cell || cell.label === 'ramka' || cell.q === undefined;
        const offsetsMm = [];
        for (let i = 0; i < 6; i++) {
            const isShared = !isDummy && HexMath.isEdgeShared(cell, i, gridManager);
            offsetsMm.push(isShared ? gap / 2 : widthMm);
        }
        const offsetsPx = offsetsMm.map(o => HexMath.mmToPixels(o, dpi));

        const outerVertices = HexMath.getOffsetOuterVertices(cx, cy, innerSizePx, orientation, offsetsPx);
        const innerVertices = HexMath.getHexVertices(cx, cy, innerSizePx, orientation);

        ctx.save();
        ctx.fillStyle = color;

        if (type === 'backing') {
            // Pełna podkładka pod heks
            ctx.beginPath();
            outerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();
        } 
        else if (type === 'outline') {
            // Ramka pusta w środku
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
            // Obwoluta z korytkiem (tło + nakładka)
            ctx.fillStyle = this.adjustColorBrightness(color, -20);
            ctx.beginPath();
            outerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();

            // Nakładka border
            ctx.fillStyle = color;
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
        return canvas;
    },

    /**
     * Tworzy kod SVG z rysunkiem ramki dla danego heksu z uwzględnieniem parametrów
     */
    createFrameSVG(cell, gridManager, type, widthMm, clearanceMm, color = '#1a1a1a') {
        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        const gap = gridManager.config.gap;

        // Rozmiar wewnętrzny heksa (rozmiar grafiki + tolerancja)
        const innerHexSizeMm = hexSize + clearanceMm;
        // Rzeczywisty maksymalny promień (circumradius) zewnętrznego heksu
        // po odsunięciu krawędzi o widthMm na zewnątrz
        const maxOuterHexSizeMm = innerHexSizeMm + widthMm / Math.cos(Math.PI / 6);

        // Bounding box zewnętrznego heksa w mm
        const outerDim = HexMath.getHexDimensions(maxOuterHexSizeMm, orientation);

        const w = outerDim.width;
        const h = outerDim.height;
        const cx = w / 2;
        const cy = h / 2;

        // Ustalenie offsetów dla każdego boku
        const isDummy = !cell || cell.label === 'ramka' || cell.q === undefined;
        const offsetsMm = [];
        for (let i = 0; i < 6; i++) {
            const isShared = !isDummy && HexMath.isEdgeShared(cell, i, gridManager);
            offsetsMm.push(isShared ? gap / 2 : widthMm);
        }

        const outerVertices = HexMath.getOffsetOuterVertices(cx, cy, innerHexSizeMm, orientation, offsetsMm);
        const innerVertices = HexMath.getHexVertices(cx, cy, innerHexSizeMm, orientation);

        // Pomocnicza funkcja formatująca punkty do formatu SVG path 'd'
        const verticesToPathD = (vertices) => {
            return vertices.map((v, idx) => `${idx === 0 ? 'M' : 'L'} ${v.x.toFixed(3)} ${v.y.toFixed(3)}`).join(' ') + ' Z';
        };

        const outerD = verticesToPathD(outerVertices);
        const innerD = verticesToPathD(innerVertices);

        let paths = '';
        if (type === 'backing') {
            paths = `<path d="${outerD}" fill="${color}" />`;
        } else if (type === 'outline') {
            paths = `<path d="${outerD} ${innerD}" fill="${color}" fill-rule="evenodd" />`;
        } else if (type === 'sleeve') {
            const darkColor = this.adjustColorBrightness(color, -20);
            paths = `<path d="${outerD}" fill="${darkColor}" />\n  <path d="${outerD} ${innerD}" fill="${color}" fill-rule="evenodd" />`;
        }

        const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}mm" height="${h.toFixed(2)}mm" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">
  ${paths}
</svg>`;

        return svgContent;
    },

    adjustColorBrightness(hex, percent) {
        let num = parseInt(hex.replace("#",""), 16),
            amt = Math.round(2.55 * percent),
            R = (num >> 16) + amt,
            G = (num >> 8 & 0x00FF) + amt,
            B = (num & 0x0000FF) + amt;
        return "#" + (0x1000000 + (R<255?R<0?0:R:255)*0x10000 + (G<255?G<0?0:G:255)*0x100 + (B<255?B<0?0:B:255)).toString(16).slice(1);
    }
};

export default FrameGenerator;
