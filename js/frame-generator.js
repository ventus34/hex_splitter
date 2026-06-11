import HexMath from './hex-math.js?v=1.0.3';

class STLModel {
    constructor(name = "ramka") {
        this.name = name;
        this.triangles = [];
    }

    addTriangle(p1, p2, p3) {
        // Compute face normal using cross product of (p2-p1) and (p3-p1)
        const ux = p2.x - p1.x;
        const uy = p2.y - p1.y;
        const uz = p2.z - p1.z;
        const vx = p3.x - p1.x;
        const vy = p3.y - p1.y;
        const vz = p3.z - p1.z;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const normal = len > 0 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 1 };
        this.triangles.push({ p1, p2, p3, normal });
    }

    addQuad(p1, p2, p3, p4) {
        this.addTriangle(p1, p2, p3);
        this.addTriangle(p1, p3, p4);
    }

    getString() {
        let s = `solid ${this.name}\n`;
        for (const t of this.triangles) {
            s += `  facet normal ${t.normal.x.toFixed(6)} ${t.normal.y.toFixed(6)} ${t.normal.z.toFixed(6)}\n`;
            s += `    outer loop\n`;
            s += `      vertex ${t.p1.x.toFixed(6)} ${t.p1.y.toFixed(6)} ${t.p1.z.toFixed(6)}\n`;
            s += `      vertex ${t.p2.x.toFixed(6)} ${t.p2.y.toFixed(6)} ${t.p2.z.toFixed(6)}\n`;
            s += `      vertex ${t.p3.x.toFixed(6)} ${t.p3.y.toFixed(6)} ${t.p3.z.toFixed(6)}\n`;
            s += `    endloop\n`;
            s += `  endfacet\n`;
        }
        s += `endsolid ${this.name}\n`;
        return s;
    }
}

const FrameGenerator = {
    /**
     * Oblicza wierzchołki wewnętrzne i zewnętrzne ramki w milimetrach (mm)
     */
    getFrameVerticesMm(cell, gridManager, widthMm, clearanceMm) {
        const config = gridManager.config;
        const hexSize = config.hexSize;
        const orientation = config.orientation;
        const stagger = config.stagger || 'left';
        const gap = config.gap;
        
        const isDummy = !cell || cell.label === 'ramka' || cell.q === undefined;
        if (isDummy) {
            const innerHexSizeMm = hexSize + clearanceMm;
            const innerVerticesMm = HexMath.getHexVertices(0, 0, innerHexSizeMm, orientation);
            const offsetsMm = Array(6).fill(widthMm);
            const outerVerticesMm = HexMath.getOffsetPolygonVertices(innerVerticesMm, offsetsMm);
            return { innerVerticesMm, outerVerticesMm };
        }

        const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        const innerHexSizeMm = hexSize + clearanceMm;
        
        // 1. Pobierz wewnętrzne wierzchołki (obcięte jeśli halfHexes jest włączone)
        let innerVerticesMm;
        if (config.halfHexes) {
            const clipConfig = {
                columns: config.columns,
                rows: config.rows,
                hexSize: innerHexSizeMm,
                orientation,
                gap
            };
            const clipRect = HexMath.getGridClipRect(clipConfig);
            const unclippedInner = HexMath.getHexVertices(posMm.x, posMm.y, innerHexSizeMm, orientation);
            innerVerticesMm = HexMath.clipPolygonToRect(unclippedInner, clipRect.xMin, clipRect.xMax, clipRect.yMin, clipRect.yMax);
        } else {
            innerVerticesMm = HexMath.getHexVertices(posMm.x, posMm.y, innerHexSizeMm, orientation);
        }
        
        // 2. Oblicz offset dla każdej krawędzi innerVerticesMm
        const offsetsMm = [];
        const n = innerVerticesMm.length;
        
        if (config.halfHexes) {
            const unclippedInner = HexMath.getHexVertices(posMm.x, posMm.y, innerHexSizeMm, orientation);
            for (let i = 0; i < n; i++) {
                const p1 = innerVerticesMm[i];
                const p2 = innerVerticesMm[(i + 1) % n];
                
                // Sprawdź na której z 6 oryginalnych krawędzi leży ten segment
                let matchedEdgeIndex = -1;
                for (let k = 0; k < 6; k++) {
                    const a = unclippedInner[k];
                    const b = unclippedInner[(k + 1) % 6];
                    if (HexMath.pointToSegmentDistance(p1, a, b) < 0.1 && HexMath.pointToSegmentDistance(p2, a, b) < 0.1) {
                        matchedEdgeIndex = k;
                        break;
                    }
                }
                
                if (matchedEdgeIndex !== -1) {
                    const isShared = HexMath.isEdgeShared(cell, matchedEdgeIndex, gridManager);
                    offsetsMm.push(isShared ? gap / 2 : widthMm);
                } else {
                    // Krawędź obcięcia (linia prosta na obrzeżu)
                    offsetsMm.push(widthMm);
                }
            }
        } else {
            for (let i = 0; i < 6; i++) {
                const isShared = HexMath.isEdgeShared(cell, i, gridManager);
                offsetsMm.push(isShared ? gap / 2 : widthMm);
            }
        }
        
        // 3. Oblicz zewnętrzne wierzchołki
        const outerVerticesMm = HexMath.getOffsetPolygonVertices(innerVerticesMm, offsetsMm);
        
        return { innerVerticesMm, outerVerticesMm };
    },

    /**
     * Tworzy płótno (canvas) z rysunkiem ramki dla danego heksu z uwzględnieniem złączy
     */
    createFrameCanvas(cell, gridManager, type, widthMm, clearanceMm, color = '#1a1a1a', customDpi = null) {
        const dpi = customDpi || gridManager.config.dpi;
        
        const { innerVerticesMm, outerVerticesMm } = this.getFrameVerticesMm(cell, gridManager, widthMm, clearanceMm);
        
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        outerVerticesMm.forEach(v => {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        });
        
        const widthMmTotal = maxX - minX;
        const heightMmTotal = maxY - minY;
        
        const canvasW = Math.round(HexMath.mmToPixels(widthMmTotal, dpi));
        const canvasH = Math.round(HexMath.mmToPixels(heightMmTotal, dpi));
        
        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;
        
        const ctx = canvas.getContext('2d');
        
        const toPixels = (v) => ({
            x: HexMath.mmToPixels(v.x - minX, dpi),
            y: HexMath.mmToPixels(v.y - minY, dpi)
        });
        
        const innerVertices = innerVerticesMm.map(toPixels);
        const outerVertices = outerVerticesMm.map(toPixels);
        
        ctx.save();
        ctx.fillStyle = color;
        
        if (type === 'backing') {
            ctx.beginPath();
            outerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();
        } 
        else if (type === 'outline') {
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
            ctx.fillStyle = this.adjustColorBrightness(color, -20);
            ctx.beginPath();
            outerVertices.forEach((v, idx) => {
                if (idx === 0) ctx.moveTo(v.x, v.y);
                else ctx.lineTo(v.x, v.y);
            });
            ctx.closePath();
            ctx.fill();

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
        const { innerVerticesMm, outerVerticesMm } = this.getFrameVerticesMm(cell, gridManager, widthMm, clearanceMm);
        
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        outerVerticesMm.forEach(v => {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        });
        
        const w = maxX - minX;
        const h = maxY - minY;
        
        const toRelative = (v) => ({
            x: v.x - minX,
            y: v.y - minY
        });
        
        const innerVertices = innerVerticesMm.map(toRelative);
        const outerVertices = outerVerticesMm.map(toRelative);
        
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
    },

    /**
     * Generuje plik STL dla ramki (trójwymiarowy model do druku 3D)
     */
    generateFrameSTL(cell, gridManager, type, widthMm, clearanceMm, heightMm, baseThicknessMm = 1.2) {
        const { innerVerticesMm, outerVerticesMm } = this.getFrameVerticesMm(cell, gridManager, widthMm, clearanceMm);
        
        if (!outerVerticesMm || outerVerticesMm.length < 3) {
            return '';
        }

        // 1. Oblicz środek ciężkości (bbox) w celu wycentrowania modelu w punkcie (0, 0)
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        outerVerticesMm.forEach(v => {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        });
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        // Pomocnicza funkcja do wymuszenia winding order Counter-Clockwise (CCW) w układzie kartezjańskim
        const makeCCW = (polygon) => {
            let area = 0;
            const n = polygon.length;
            for (let i = 0; i < n; i++) {
                const p1 = polygon[i];
                const p2 = polygon[(i + 1) % n];
                area += (p1.x * p2.y - p2.x * p1.y);
            }
            if (area < 0) {
                polygon.reverse();
            }
            return polygon;
        };

        // Przekształć wierzchołki na współrzędne lokalne z odwróconą osią Y (dla poprawnej orientacji w druku 3D)
        const localOuter = makeCCW(outerVerticesMm.map(v => ({ x: v.x - cx, y: -(v.y - cy) })));
        const localInner = makeCCW(innerVerticesMm.map(v => ({ x: v.x - cx, y: -(v.y - cy) })));

        const n = localOuter.length;
        const H = heightMm;
        const B = Math.min(baseThicknessMm, H - 0.4); // Zabezpieczenie przed ujemną wysokością rantów

        const writer = new STLModel(`ramka_${cell ? cell.label : 'custom'}`);

        if (type === 'backing') {
            // Płyta pełna (solid backing plate)
            // Dół (z = 0) - CW
            for (let i = 1; i < n - 1; i++) {
                writer.addTriangle(
                    { x: localOuter[0].x, y: localOuter[0].y, z: 0 },
                    { x: localOuter[i+1].x, y: localOuter[i+1].y, z: 0 },
                    { x: localOuter[i].x, y: localOuter[i].y, z: 0 }
                );
            }
            // Góra (z = H) - CCW
            for (let i = 1; i < n - 1; i++) {
                writer.addTriangle(
                    { x: localOuter[0].x, y: localOuter[0].y, z: H },
                    { x: localOuter[i].x, y: localOuter[i].y, z: H },
                    { x: localOuter[i+1].x, y: localOuter[i+1].y, z: H }
                );
            }
            // Ściany boczne zewnętrzne
            for (let i = 0; i < n; i++) {
                const p1 = localOuter[i];
                const p2 = localOuter[(i + 1) % n];
                writer.addQuad(
                    { x: p1.x, y: p1.y, z: 0 },
                    { x: p2.x, y: p2.y, z: 0 },
                    { x: p2.x, y: p2.y, z: H },
                    { x: p1.x, y: p1.y, z: H }
                );
            }
        } 
        else if (type === 'outline') {
            // Ramka pusta (hollow outline frame)
            // Dół (z = 0) - pierścień annulus (CW)
            for (let i = 0; i < n; i++) {
                const o1 = localOuter[i];
                const o2 = localOuter[(i + 1) % n];
                const i1 = localInner[i];
                const i2 = localInner[(i + 1) % n];
                writer.addQuad(
                    { x: o1.x, y: o1.y, z: 0 },
                    { x: i1.x, y: i1.y, z: 0 },
                    { x: i2.x, y: i2.y, z: 0 },
                    { x: o2.x, y: o2.y, z: 0 }
                );
            }
            // Góra (z = H) - pierścień annulus (CCW)
            for (let i = 0; i < n; i++) {
                const o1 = localOuter[i];
                const o2 = localOuter[(i + 1) % n];
                const i1 = localInner[i];
                const i2 = localInner[(i + 1) % n];
                writer.addQuad(
                    { x: o1.x, y: o1.y, z: H },
                    { x: o2.x, y: o2.y, z: H },
                    { x: i2.x, y: i2.y, z: H },
                    { x: i1.x, y: i1.y, z: H }
                );
            }
            // Ściany boczne zewnętrzne
            for (let i = 0; i < n; i++) {
                const p1 = localOuter[i];
                const p2 = localOuter[(i + 1) % n];
                writer.addQuad(
                    { x: p1.x, y: p1.y, z: 0 },
                    { x: p2.x, y: p2.y, z: 0 },
                    { x: p2.x, y: p2.y, z: H },
                    { x: p1.x, y: p1.y, z: H }
                );
            }
            // Ściany boczne wewnętrzne
            for (let i = 0; i < n; i++) {
                const p1 = localInner[i];
                const p2 = localInner[(i + 1) % n];
                writer.addQuad(
                    { x: p2.x, y: p2.y, z: 0 },
                    { x: p1.x, y: p1.y, z: 0 },
                    { x: p1.x, y: p1.y, z: H },
                    { x: p2.x, y: p2.y, z: H }
                );
            }
        } 
        else if (type === 'sleeve') {
            // Obwoluta z dnem (sleeve with pocket)
            // Cały dół (z = 0) - CW
            for (let i = 1; i < n - 1; i++) {
                writer.addTriangle(
                    { x: localOuter[0].x, y: localOuter[0].y, z: 0 },
                    { x: localOuter[i+1].x, y: localOuter[i+1].y, z: 0 },
                    { x: localOuter[i].x, y: localOuter[i].y, z: 0 }
                );
            }
            // Dno kieszeni wewnętrznej (z = B) - CCW
            for (let i = 1; i < n - 1; i++) {
                writer.addTriangle(
                    { x: localInner[0].x, y: localInner[0].y, z: B },
                    { x: localInner[i].x, y: localInner[i].y, z: B },
                    { x: localInner[i+1].x, y: localInner[i+1].y, z: B }
                );
            }
            // Góra rantów (z = H) - pierścień annulus (CCW)
            for (let i = 0; i < n; i++) {
                const o1 = localOuter[i];
                const o2 = localOuter[(i + 1) % n];
                const i1 = localInner[i];
                const i2 = localInner[(i + 1) % n];
                writer.addQuad(
                    { x: o1.x, y: o1.y, z: H },
                    { x: o2.x, y: o2.y, z: H },
                    { x: i2.x, y: i2.y, z: H },
                    { x: i1.x, y: i1.y, z: H }
                );
            }
            // Ściany zewnętrzne (od z = 0 do z = H)
            for (let i = 0; i < n; i++) {
                const p1 = localOuter[i];
                const p2 = localOuter[(i + 1) % n];
                writer.addQuad(
                    { x: p1.x, y: p1.y, z: 0 },
                    { x: p2.x, y: p2.y, z: 0 },
                    { x: p2.x, y: p2.y, z: H },
                    { x: p1.x, y: p1.y, z: H }
                );
            }
            // Ściany wewnętrzne kieszeni (od z = B do z = H)
            for (let i = 0; i < n; i++) {
                const p1 = localInner[i];
                const p2 = localInner[(i + 1) % n];
                writer.addQuad(
                    { x: p2.x, y: p2.y, z: B },
                    { x: p1.x, y: p1.y, z: B },
                    { x: p1.x, y: p1.y, z: H },
                    { x: p2.x, y: p2.y, z: H }
                );
            }
        }

        return writer.getString();
    }
};

export default FrameGenerator;
