const GEOMETRY_EPSILON = 1e-9;

function polygonArea(vertices) {
    let area = 0;
    for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        area += a.x * b.y - b.x * a.y;
    }
    return area / 2;
}

function cleanPolygon(vertices) {
    if (!Array.isArray(vertices)) return [];
    const clean = [];
    for (const vertex of vertices) {
        if (!vertex || !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) return [];
        const previous = clean[clean.length - 1];
        if (!previous || Math.hypot(vertex.x - previous.x, vertex.y - previous.y) > GEOMETRY_EPSILON) {
            clean.push({ x: vertex.x, y: vertex.y });
        }
    }
    if (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= GEOMETRY_EPSILON) {
        clean.pop();
    }

    // Clipping can leave duplicate or collinear points at rectangle corners.
    let changed = true;
    while (changed && clean.length >= 3) {
        changed = false;
        for (let i = 0; i < clean.length; i++) {
            const a = clean[(i - 1 + clean.length) % clean.length];
            const b = clean[i];
            const c = clean[(i + 1) % clean.length];
            const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            const scale = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y));
            if (Math.abs(cross) <= GEOMETRY_EPSILON * scale) {
                clean.splice(i, 1);
                changed = true;
                break;
            }
        }
    }
    return clean.length >= 3 && Math.abs(polygonArea(clean)) > GEOMETRY_EPSILON ? clean : [];
}

/**
 * HexMath - Matematyka i geometria siatki heksagonalnej
 */
const HexMath = {
    // Współczynnik przeliczenia cali na mm
    MM_PER_INCH: 25.4,

    /**
     * Konwersja milimetrów na piksele w oparciu o DPI
     */
    mmToPixels(mm, dpi = 300) {
        return (mm / this.MM_PER_INCH) * dpi;
    },

    /**
     * Konwersja pikseli na milimetry w oparciu o DPI
     */
    pixelsToMm(px, dpi = 300) {
        return (px / dpi) * this.MM_PER_INCH;
    },

    /**
     * Pobiera wierzchołki heksagonu wokół określonego środka
     * @param {number} cx - Środek X
     * @param {number} cy - Środek Y
     * @param {number} size - Rozmiar (circumradius)
     * @param {string} orientation - 'flat-top' lub 'pointy-top'
     * @returns {Array<{x: number, y: number}>}
     */
    getHexVertices(cx, cy, size, orientation = 'flat-top') {
        const vertices = [];
        const startAngleDeg = orientation === 'flat-top' ? 0 : 30;
        
        for (let i = 0; i < 6; i++) {
            const angleDeg = 60 * i + startAngleDeg;
            const angleRad = (Math.PI / 180) * angleDeg;
            vertices.push({
                x: cx + size * Math.cos(angleRad),
                y: cy + size * Math.sin(angleRad)
            });
        }
        return vertices;
    },

    /**
     * Konwertuje współrzędne axialne (q, r) na współrzędne pikselowe (x, y)
     * @param {number} q - Kolumna axialna
     * @param {number} r - Wiersz axialny
     * @param {number} size - Rozmiar heksagonu (circumradius)
     * @param {string} orientation - 'flat-top' lub 'pointy-top'
     * @param {number} gap - Szczelina między heksami
     * @param {string} stagger - 'left' lub 'right'
     * @returns {{x: number, y: number}}
     */
    axialToPixel(q, r, size, orientation = 'flat-top', gap = 0, stagger = 'left') {
        let x = 0;
        let y = 0;

        if (orientation === 'flat-top') {
            // Flat-top:
            // Szerokość heksa = 2 * size
            // Wysokość heksa = sqrt(3) * size
            // Horyzontalny dystans między centrami sąsiadów = 1.5 * size + gap_offset
            // Wertykalny dystans między centrami sąsiadów = sqrt(3) * size + gap_offset
            const horizSpacing = 1.5 * size + (gap * 1.5 / Math.sqrt(3));
            const vertSpacing = Math.sqrt(3) * size + gap;
            
            x = horizSpacing * q;
            
            const offset = (stagger === 'right')
                ? (((q & 1) === 0) ? 0.5 : 0)
                : (((q & 1) === 0) ? 0 : 0.5);
            y = vertSpacing * (r + Math.floor(q / 2) + offset);
        } else {
            // Pointy-top:
            // Szerokość heksa = sqrt(3) * size
            // Wysokość heksa = 2 * size
            // Horyzontalny dystans między centrami = sqrt(3) * size + gap
            // Wertykalny dystans = 1.5 * size + gap_offset
            const horizSpacing = Math.sqrt(3) * size + gap;
            const vertSpacing = 1.5 * size + (gap * 1.5 / Math.sqrt(3));
            
            const offset = (stagger === 'right')
                ? (((r & 1) === 0) ? 0.5 : 0)
                : (((r & 1) === 0) ? 0 : 0.5);
            x = horizSpacing * (q + Math.floor(r / 2) + offset);
            y = vertSpacing * r;
        }

        return { x, y };
    },

    /**
     * Konwertuje współrzędne pikselowe (x, y) na współrzędne axialne (q, r)
     * @param {number} px - Pozycja X piksela
     * @param {number} py - Pozycja Y piksela
     * @param {number} size - Rozmiar heksagonu (circumradius)
     * @param {string} orientation - 'flat-top' lub 'pointy-top'
     * @param {number} gap - Szczelina między heksami
     * @param {string} stagger - 'left' lub 'right'
     * @returns {{q: number, r: number}}
     */
    pixelToAxial(px, py, size, orientation = 'flat-top', gap = 0, stagger = 'left') {
        let q = 0;
        let r = 0;

        if (orientation === 'flat-top') {
            const horizSpacing = 1.5 * size + (gap * 1.5 / Math.sqrt(3));
            const vertSpacing = Math.sqrt(3) * size + gap;
            
            q = px / horizSpacing;
            const roundedQ = Math.round(q);
            const term = (stagger === 'right')
                ? (roundedQ / 2 + 0.5 * Math.cos(Math.PI * roundedQ))
                : (roundedQ / 2);
            r = (py / vertSpacing) - term;
            q = roundedQ;
        } else {
            const horizSpacing = Math.sqrt(3) * size + gap;
            const vertSpacing = 1.5 * size + (gap * 1.5 / Math.sqrt(3));
            
            r = py / vertSpacing;
            const roundedR = Math.round(r);
            const term = (stagger === 'right')
                ? (roundedR / 2 + 0.5 * Math.cos(Math.PI * roundedR))
                : (roundedR / 2);
            q = (px / horizSpacing) - term;
            r = roundedR;
        }

        return this.hexRound(q, r);
    },

    /**
     * Zaokrągla ułamkowe współrzędne axialne do najbliższego heksagonu
     */
    hexRound(q, r) {
        const s = -q - r;
        
        let rq = Math.round(q);
        let rr = Math.round(r);
        let rs = Math.round(s);

        const dq = Math.abs(rq - q);
        const dr = Math.abs(rr - r);
        const ds = Math.abs(rs - s);

        if (dq > dr && dq > ds) {
            rq = -rr - rs;
        } else if (dr > ds) {
            rr = -rq - rs;
        }

        return { q: rq, r: rr };
    },

    /**
     * Oblicza odległość w siatce (w heksach) między dwoma punktami
     */
    hexDistance(q1, r1, q2, r2) {
        return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
    },

    /**
     * Zwraca całkowite wymiary (szerokość i wysokość) heksagonu
     */
    getHexDimensions(size, orientation = 'flat-top') {
        if (orientation === 'flat-top') {
            return {
                width: 2 * size,
                height: Math.sqrt(3) * size
            };
        } else {
            return {
                width: Math.sqrt(3) * size,
                height: 2 * size
            };
        }
    },

    /**
     * Zwraca przesunięcie axialne do sąsiada dla danej krawędzi
     */
    getNeighborOffset(edgeIndex, orientation = 'flat-top', stagger = 'left', q = 0, r = 0) {
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex > 5 ||
            !['flat-top', 'pointy-top'].includes(orientation) ||
            !Number.isInteger(q) || !Number.isInteger(r)) return undefined;

        // Convert the drawing's parity-based offset back into the integer
        // coordinates for the neighbor on each geometric edge. This keeps
        // lookup constant-time while accounting for right-stagger parity.
        const rowOffset = index => {
            const half = Math.floor(index / 2);
            const odd = Math.abs(index % 2) === 1;
            if (stagger === 'right') return half + (odd ? 0 : 0.5);
            return half + (odd ? 0.5 : 0);
        };

        if (orientation === 'flat-top') {
            const deltaQ = [1, 0, -1, -1, 0, 1][edgeIndex];
            const desiredRows = [0.5, 1, 0.5, -0.5, -1, -0.5][edgeIndex];
            const actualRowShift = rowOffset(q + deltaQ) - rowOffset(q);
            return { q: deltaQ, r: Math.round(desiredRows - actualRowShift) };
        }

        const deltaR = [1, 1, 0, -1, -1, 0][edgeIndex];
        const desiredColumns = [0.5, -0.5, -1, -0.5, 0.5, 1][edgeIndex];
        const actualColumnShift = rowOffset(r + deltaR) - rowOffset(r);
        return { q: Math.round(desiredColumns - actualColumnShift), r: deltaR };
    },

    /**
     * Sprawdza czy dana krawędź jest współdzielona z aktywnym sąsiadem
     */
    isEdgeShared(cell, edgeIndex, gridManager) {
        if (!cell || !gridManager) return false;
        const offset = this.getNeighborOffset(
            edgeIndex,
            gridManager.config.orientation,
            gridManager.config.stagger || 'left',
            cell.q,
            cell.r
        );
        if (!offset) return false;
        const neighborQ = cell.q + offset.q;
        const neighborR = cell.r + offset.r;
        const neighbor = gridManager.getCell(neighborQ, neighborR);
        return neighbor && neighbor.enabled;
    },

    /**
     * Oblicza wierzchołki zewnętrzne heksagonu przesunięte na zewnątrz o zadane offsety dla każdej krawędzi
     */
    getOffsetOuterVertices(cx, cy, innerSize, orientation, offsets) {
        const innerVertices = this.getHexVertices(cx, cy, innerSize, orientation);
        const shiftedLines = [];
        
        for (let i = 0; i < 6; i++) {
            const p1 = innerVertices[i];
            const p2 = innerVertices[(i + 1) % 6];
            
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.sqrt(dx*dx + dy*dy);
            
            // Wektor normalny na zewnątrz (w prawo od wektora CCW)
            const nx = dy / len;
            const ny = -dx / len;
            
            const offset = offsets[i];
            shiftedLines.push({
                p1: { x: p1.x + nx * offset, y: p1.y + ny * offset },
                p2: { x: p2.x + nx * offset, y: p2.y + ny * offset }
            });
        }
        
        const outerVertices = [];
        for (let i = 0; i < 6; i++) {
            const linePrev = shiftedLines[(i - 1 + 6) % 6];
            const lineCurr = shiftedLines[i];
            
            const intersection = this.lineIntersection(linePrev.p1, linePrev.p2, lineCurr.p1, lineCurr.p2);
            if (intersection) {
                outerVertices.push(intersection);
            } else {
                outerVertices.push({ x: innerVertices[i].x, y: innerVertices[i].y });
            }
        }
        
        return outerVertices;
    },

    /**
     * Punkt przecięcia dwóch linii A-B oraz C-D
     */
    lineIntersection(A, B, C, D) {
        const denom = (A.x - B.x) * (C.y - D.y) - (A.y - B.y) * (C.x - D.x);
        if (Math.abs(denom) < 1e-6) return null;
        const t = ((A.x - C.x) * (C.y - D.y) - (A.y - C.y) * (C.x - D.x)) / denom;
        return {
            x: A.x + t * (B.x - A.x),
            y: A.y + t * (B.y - A.y)
        };
    },

    /**
     * Oblicza odległość punktu P do odcinka AB
     */
    pointToSegmentDistance(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx*dx + dy*dy;
        if (lenSq === 0) return Math.sqrt((p.x - a.x)**2 + (p.y - a.y)**2);
        
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        
        const projX = a.x + t * dx;
        const projY = a.y + t * dy;
        return Math.sqrt((p.x - projX)**2 + (p.y - projY)**2);
    },

    /**
     * Sutherland-Hodgman algorytm obcinania wielokąta do prostokąta
     */
    clipPolygonToRect(vertices, xMin, xMax, yMin, yMax) {
        if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return [];
        let current = cleanPolygon(vertices);
        if (current.length === 0) return [];

        const boundaries = [
            { inside: p => p.x >= xMin, intersect: (a, b) => ({ x: xMin, y: a.y + (b.y - a.y) * (xMin - a.x) / (b.x - a.x) }) },
            { inside: p => p.x <= xMax, intersect: (a, b) => ({ x: xMax, y: a.y + (b.y - a.y) * (xMax - a.x) / (b.x - a.x) }) },
            { inside: p => p.y >= yMin, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (yMin - a.y) / (b.y - a.y), y: yMin }) },
            { inside: p => p.y <= yMax, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (yMax - a.y) / (b.y - a.y), y: yMax }) }
        ];

        for (const boundary of boundaries) {
            const output = [];
            if (current.length === 0) return [];
            let previous = current[current.length - 1];
            let previousInside = boundary.inside(previous);
            for (const point of current) {
                const pointInside = boundary.inside(point);
                if (pointInside !== previousInside) output.push(boundary.intersect(previous, point));
                if (pointInside) output.push(point);
                previous = point;
                previousInside = pointInside;
            }
            current = cleanPolygon(output);
        }
        return current;
    },

    /**
     * Zwraca prostokąt obcinający całą siatkę w mm
     */
    getGridClipRect(gridConfig) {
        if (!gridConfig || typeof gridConfig !== 'object') return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
        const { columns, rows, hexSize, orientation, gap = 0, stagger = 'left' } = gridConfig;
        if (![columns, rows, hexSize, gap].every(Number.isFinite) ||
            !Number.isInteger(columns) || !Number.isInteger(rows) ||
            columns < 1 || rows < 1 || hexSize <= 0 || gap < 0 ||
            !['flat-top', 'pointy-top'].includes(orientation)) {
            return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
        }
        const origin = this.axialToPixel(0, 0, hexSize, orientation, gap, stagger);
        const halfHexWidth = orientation === 'flat-top' ? hexSize : Math.sqrt(3) * hexSize / 2;
        const halfHexHeight = orientation === 'flat-top' ? Math.sqrt(3) * hexSize / 2 : hexSize;
        if (orientation === 'flat-top') {
            const horizSpacing = 1.5 * hexSize + (gap * 1.5 / Math.sqrt(3));
            const vertSpacing = Math.sqrt(3) * hexSize + gap;
            return {
                xMin: columns === 1 ? origin.x - halfHexWidth : 0,
                xMax: columns === 1 ? origin.x + halfHexWidth : (columns - 1) * horizSpacing,
                yMin: rows === 1 && columns === 1 ? origin.y - halfHexHeight : 0,
                yMax: rows === 1 && columns === 1 ? origin.y + halfHexHeight : (rows - 0.5) * vertSpacing
            };
        } else {
            const horizSpacing = Math.sqrt(3) * hexSize + gap;
            const vertSpacing = 1.5 * hexSize + (gap * 1.5 / Math.sqrt(3));
            return {
                xMin: columns === 1 && rows === 1 ? origin.x - halfHexWidth : 0,
                xMax: columns === 1 && rows === 1 ? origin.x + halfHexWidth : (columns - 0.5) * horizSpacing,
                yMin: rows === 1 ? origin.y - halfHexHeight : 0,
                yMax: rows === 1 ? origin.y + halfHexHeight : (rows - 1) * vertSpacing
            };
        }
    },

    /**
     * Pobiera wierzchołki heksagonu (obcięte, jeśli włączone są pół-heksy)
     */
    getCellVertices(cell, gridConfig, customSize = null) {
        if (!gridConfig) return [];
        const size = customSize || gridConfig.hexSize;
        const orientation = gridConfig.orientation;
        const stagger = gridConfig.stagger || 'left';
        const gap = gridConfig.gap || 0;

        if (!cell || !Number.isFinite(cell.q) || !Number.isFinite(cell.r) ||
            !Number.isFinite(size) || size <= 0 || !Number.isFinite(gap) || gap < 0 ||
            !['flat-top', 'pointy-top'].includes(orientation)) return [];

        const pos = this.axialToPixel(cell.q, cell.r, size, orientation, gap, stagger);
        const vertices = this.getHexVertices(pos.x, pos.y, size, orientation);

        if (gridConfig.halfHexes) {
            const clipConfig = {
                columns: gridConfig.columns,
                rows: gridConfig.rows,
                hexSize: size,
                orientation,
                gap,
                stagger
            };
            const clipRect = this.getGridClipRect(clipConfig);
            if (clipRect.xMin >= clipRect.xMax || clipRect.yMin >= clipRect.yMax) return [];
            return this.clipPolygonToRect(vertices, clipRect.xMin, clipRect.xMax, clipRect.yMin, clipRect.yMax);
        }
        return vertices;
    },

    /**
     * Przesuwa krawędzie dowolnego wielokąta o zadane offsety
     */
    getOffsetPolygonVertices(vertices, offsets) {
        const shiftedLines = [];
        const polygon = cleanPolygon(vertices);
        const n = polygon.length;
        if (n === 0 || !Array.isArray(offsets)) return [];
        
        for (let i = 0; i < n; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % n];
            
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.sqrt(dx*dx + dy*dy);
            
            if (len < 1e-6) {
                shiftedLines.push({ p1: { ...p1 }, p2: { ...p2 } });
                continue;
            }
            
            // Wektor normalny na zewnątrz (w prawo od wektora CCW)
            const nx = dy / len;
            const ny = -dx / len;
            
            const offset = offsets[i] !== undefined ? offsets[i] : 0;
            if (!Number.isFinite(offset)) return [];
            shiftedLines.push({
                p1: { x: p1.x + nx * offset, y: p1.y + ny * offset },
                p2: { x: p2.x + nx * offset, y: p2.y + ny * offset }
            });
        }
        
        const outerVertices = [];
        for (let i = 0; i < n; i++) {
            const linePrev = shiftedLines[(i - 1 + n) % n];
            const lineCurr = shiftedLines[i];
            
            const intersection = this.lineIntersection(linePrev.p1, linePrev.p2, lineCurr.p1, lineCurr.p2);
            if (intersection) {
                outerVertices.push(intersection);
            } else {
                outerVertices.push({ x: polygon[i].x, y: polygon[i].y });
            }
        }
        
        return cleanPolygon(outerVertices);
    }
};

export default HexMath;
