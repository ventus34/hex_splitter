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
    getNeighborOffset(edgeIndex, orientation = 'flat-top') {
        if (orientation === 'flat-top') {
            const offsets = [
                { q: 1, r: 0 },   // E0: dolna-prawa
                { q: 0, r: 1 },   // E1: dolna
                { q: -1, r: 1 },  // E2: dolna-lewa
                { q: -1, r: 0 },  // E3: górna-lewa
                { q: 0, r: -1 },  // E4: górna
                { q: 1, r: -1 }   // E5: górna-prawa
            ];
            return offsets[edgeIndex];
        } else {
            const offsets = [
                { q: 0, r: 1 },   // E0: dolna-prawa
                { q: -1, r: 1 },  // E1: dolna-lewa
                { q: -1, r: 0 },  // E2: lewa (pionowa)
                { q: 0, r: -1 },  // E3: górna-lewa
                { q: 1, r: -1 },  // E4: górna-prawa
                { q: 1, r: 0 }    // E5: prawa (pionowa)
            ];
            return offsets[edgeIndex];
        }
    },

    /**
     * Sprawdza czy dana krawędź jest współdzielona z aktywnym sąsiadem
     */
    isEdgeShared(cell, edgeIndex, gridManager) {
        if (!cell || !gridManager) return false;
        const offset = this.getNeighborOffset(edgeIndex, gridManager.config.orientation);
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
        let current = vertices;

        // Clip against left: x >= xMin
        let next = [];
        let len = current.length;
        for (let i = 0; i < len; i++) {
            const p1 = current[i];
            const p2 = current[(i + 1) % len];
            if (p1.x >= xMin) {
                if (p2.x >= xMin) {
                    next.push(p2);
                } else {
                    const t = (xMin - p1.x) / (p2.x - p1.x);
                    next.push({ x: xMin, y: p1.y + t * (p2.y - p1.y) });
                }
            } else {
                if (p2.x >= xMin) {
                    const t = (xMin - p1.x) / (p2.x - p1.x);
                    next.push({ x: xMin, y: p1.y + t * (p2.y - p1.y) });
                    next.push(p2);
                }
            }
        }
        current = next;

        // Clip against right: x <= xMax
        next = [];
        len = current.length;
        if (len === 0) return [];
        for (let i = 0; i < len; i++) {
            const p1 = current[i];
            const p2 = current[(i + 1) % len];
            if (p1.x <= xMax) {
                if (p2.x <= xMax) {
                    next.push(p2);
                } else {
                    const t = (xMax - p1.x) / (p2.x - p1.x);
                    next.push({ x: xMax, y: p1.y + t * (p2.y - p1.y) });
                }
            } else {
                if (p2.x <= xMax) {
                    const t = (xMax - p1.x) / (p2.x - p1.x);
                    next.push({ x: xMax, y: p1.y + t * (p2.y - p1.y) });
                    next.push(p2);
                }
            }
        }
        current = next;

        // Clip against top: y >= yMin
        next = [];
        len = current.length;
        if (len === 0) return [];
        for (let i = 0; i < len; i++) {
            const p1 = current[i];
            const p2 = current[(i + 1) % len];
            if (p1.y >= yMin) {
                if (p2.y >= yMin) {
                    next.push(p2);
                } else {
                    const t = (yMin - p1.y) / (p2.y - p1.y);
                    next.push({ x: p1.x + t * (p2.x - p1.x), y: yMin });
                }
            } else {
                if (p2.y >= yMin) {
                    const t = (yMin - p1.y) / (p2.y - p1.y);
                    next.push({ x: p1.x + t * (p2.x - p1.x), y: yMin });
                    next.push(p2);
                }
            }
        }
        current = next;

        // Clip against bottom: y <= yMax
        next = [];
        len = current.length;
        if (len === 0) return [];
        for (let i = 0; i < len; i++) {
            const p1 = current[i];
            const p2 = current[(i + 1) % len];
            if (p1.y <= yMax) {
                if (p2.y <= yMax) {
                    next.push(p2);
                } else {
                    const t = (yMax - p1.y) / (p2.y - p1.y);
                    next.push({ x: p1.x + t * (p2.x - p1.x), y: yMax });
                }
            } else {
                if (p2.y <= yMax) {
                    const t = (yMax - p1.y) / (p2.y - p1.y);
                    next.push({ x: p1.x + t * (p2.x - p1.x), y: yMax });
                    next.push(p2);
                }
            }
        }
        return next;
    },

    /**
     * Zwraca prostokąt obcinający całą siatkę w mm
     */
    getGridClipRect(gridConfig) {
        const { columns, rows, hexSize, orientation, gap } = gridConfig;
        if (orientation === 'flat-top') {
            const horizSpacing = 1.5 * hexSize + (gap * 1.5 / Math.sqrt(3));
            const vertSpacing = Math.sqrt(3) * hexSize + gap;
            return {
                xMin: 0,
                xMax: (columns - 1) * horizSpacing,
                yMin: 0,
                yMax: (rows - 0.5) * vertSpacing
            };
        } else {
            const horizSpacing = Math.sqrt(3) * hexSize + gap;
            const vertSpacing = 1.5 * hexSize + (gap * 1.5 / Math.sqrt(3));
            return {
                xMin: 0,
                xMax: (columns - 0.5) * horizSpacing,
                yMin: 0,
                yMax: (rows - 1) * vertSpacing
            };
        }
    },

    /**
     * Pobiera wierzchołki heksagonu (obcięte, jeśli włączone są pół-heksy)
     */
    getCellVertices(cell, gridConfig, customSize = null) {
        const size = customSize || gridConfig.hexSize;
        const orientation = gridConfig.orientation;
        const stagger = gridConfig.stagger || 'left';
        const gap = gridConfig.gap || 0;

        const pos = this.axialToPixel(cell.q, cell.r, size, orientation, gap, stagger);
        const vertices = this.getHexVertices(pos.x, pos.y, size, orientation);

        if (gridConfig.halfHexes) {
            const clipConfig = {
                columns: gridConfig.columns,
                rows: gridConfig.rows,
                hexSize: size,
                orientation,
                gap
            };
            const clipRect = this.getGridClipRect(clipConfig);
            return this.clipPolygonToRect(vertices, clipRect.xMin, clipRect.xMax, clipRect.yMin, clipRect.yMax);
        }
        return vertices;
    },

    /**
     * Przesuwa krawędzie dowolnego wielokąta o zadane offsety
     */
    getOffsetPolygonVertices(vertices, offsets) {
        const shiftedLines = [];
        const n = vertices.length;
        if (n === 0) return [];
        
        for (let i = 0; i < n; i++) {
            const p1 = vertices[i];
            const p2 = vertices[(i + 1) % n];
            
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
                outerVertices.push({ x: vertices[i].x, y: vertices[i].y });
            }
        }
        
        return outerVertices;
    }
};

export default HexMath;
