import HexMath from './hex-math.js?v=1.0.3';

const STLHexGenerator = {
    /**
     * Generuje binarny bufor STL dla pojedynczego heksa
     * @param {CellState} cell - Komórka heksagonalna
     * @param {GridManager} gridManager - Zarządca siatki
     * @param {ImageProcessor} imageProcessor - Procesor obrazów
     * @param {Object} options - Parametry trójwymiarowego reliefu (reliefHeight, baseThickness, invert, sectors, rings)
     * @returns {ArrayBuffer|null}
     */
    generateHexSTL(cell, gridManager, imageProcessor, options) {
        if (!cell.enabled || !cell.imageId) return null;

        // 1. Pobierz obraz i kadr komórki
        const imageObj = imageProcessor.getImage(cell.imageId);
        if (!imageObj) return null;

        const crop = cell.cropRegion;
        const sourceElement = imageProcessor.getRotatedCanvasOrImage(imageObj);

        // 2. Stwórz bufor próbkowania 256x256 i nałóż rozmycie CSS przed narysowaniem prostokątnego kadru
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = 256;
        sampleCanvas.height = 256;
        const sampleCtx = sampleCanvas.getContext('2d');

        const blurRadius = options.blur !== undefined ? parseFloat(options.blur) : 1.5;
        if (blurRadius > 0) {
            sampleCtx.filter = `blur(${blurRadius}px)`;
        }

        if (crop) {
            sampleCtx.drawImage(
                sourceElement,
                crop.x, crop.y, crop.w, crop.h,
                0, 0, 256, 256
            );
        } else {
            sampleCtx.drawImage(sourceElement, 0, 0, 256, 256);
        }

        const imgData = sampleCtx.getImageData(0, 0, 256, 256);
        const pixels = imgData.data;

        // 3. Pobierz wierzchołki w skali milimetrowej
        const verticesMm = HexMath.getCellVertices(cell, gridManager.config);
        if (verticesMm.length < 3) return null;

        // 4. Oblicz środek ciężkości (centroid)
        let sumX = 0, sumY = 0;
        verticesMm.forEach(v => {
            sumX += v.x;
            sumY += v.y;
        });
        const cx = sumX / verticesMm.length;
        const cy = sumY / verticesMm.length;

        // Bounding box nieobciętego heksu w mm
        const hexSize = gridManager.config.hexSize;
        const orientation = gridManager.config.orientation;
        const gap = gridManager.config.gap || 0;
        const stagger = gridManager.config.stagger || 'left';
        const hexDim = HexMath.getHexDimensions(hexSize, orientation);
        const posMm = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);

        const unclippedMinX = posMm.x - hexDim.width / 2;
        const unclippedMinY = posMm.y - hexDim.height / 2;

        const Sectors = parseInt(options.sectors) || 120;
        const Rings = parseInt(options.rings) || 60;
        const baseThickness = parseFloat(options.baseThickness) || 1.2;
        const reliefHeight = parseFloat(options.reliefHeight) || 2.0;
        const invert = !!options.invert;

        // Pomocnicza funkcja do próbkowania wysokości w skali mm
        function sampleHeight(xVal, yVal) {
            // Mapuj (xVal, yVal) względem nieobciętego heksu
            let u = (xVal - unclippedMinX) / hexDim.width;
            let v = (yVal - unclippedMinY) / hexDim.height;
            u = Math.max(0, Math.min(1, u));
            v = Math.max(0, Math.min(1, v));

            const col_px = Math.max(0, Math.min(255, Math.round(u * 255)));
            const row_px = Math.max(0, Math.min(255, Math.round(v * 255)));
            const idx = (row_px * 256 + col_px) * 4;

            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const a = pixels[idx + 3];

            if (a < 30) return 0; // Przezroczyste piksele traktujemy jako tło

            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

            // Invert:
            // false (Domyślnie): Biel (255) to reliefHeight (wysoko), Czerń (0) to 0 (wyrzeźbiona linia)
            // true: Czerń (0) to reliefHeight (wysoko), Biel (255) to 0 (wyrzeźbiona biel)
            let factor = luminance / 255.0;
            if (invert) {
                factor = 1.0 - factor;
            }

            return factor * reliefHeight;
        }

        // Pomocnicza funkcja do znajdowania przecięcia promienia z wielokątem (heksa)
        function findRayPolygonIntersection(C, theta, vertices) {
            const ux = Math.cos(theta);
            const uy = Math.sin(theta);
            const n = vertices.length;
            for (let i = 0; i < n; i++) {
                const A = vertices[i];
                const B = vertices[(i + 1) % n];
                const dx = B.x - A.x;
                const dy = B.y - A.y;
                const det = -ux * dy + uy * dx;
                if (Math.abs(det) < 1e-9) continue;

                const s = (-dx * (A.y - C.y) + dy * (A.x - C.x)) / det;
                const t = (ux * (A.y - C.y) - uy * (A.x - C.x)) / det;
                if (s >= 0 && t >= -0.0001 && t <= 1.0001) {
                    return { x: C.x + s * ux, y: C.y + s * uy };
                }
            }
            return { x: C.x, y: C.y };
        }

        // 5. Zbuduj siatkę radialną wierzchołków
        const grid = Array.from({ length: Rings + 1 }, () => []);

        // Środek (Ring 0)
        const hc = sampleHeight(cx, cy);
        for (let s = 0; s < Sectors; s++) {
            grid[0].push({ lx: 0, ly: 0, z: baseThickness + hc });
        }

        // Kolejne pierścienie w skali
        for (let r = 1; r <= Rings; r++) {
            const f = r / Rings;
            for (let s = 0; s < Sectors; s++) {
                const theta = s * 2 * Math.PI / Sectors;
                const P_boundary = findRayPolygonIntersection({ x: cx, y: cy }, theta, verticesMm);
                const px = cx + f * (P_boundary.x - cx);
                const py = cy + f * (P_boundary.y - cy);

                const h = sampleHeight(px, py);
                const z = baseThickness + h;

                // Odwrócenie osi Y dla układu kartezjańskiego 3D
                grid[r].push({
                    lx: px - cx,
                    ly: -(py - cy),
                    z: z
                });
            }
        }

        // 6. Generowanie trójkątów (CCW winding order)
        const triangles = [];

        // Powierzchnia Górna (Top Surface)
        // Środek do pierścienia 1
        for (let s = 0; s < Sectors; s++) {
            const sNext = (s + 1) % Sectors;
            triangles.push({
                p1: grid[0][0],
                p2: grid[1][s],
                p3: grid[1][sNext]
            });
        }

        // Pomiędzy pierścieniami 1 do Rings
        for (let r = 1; r < Rings; r++) {
            for (let s = 0; s < Sectors; s++) {
                const sNext = (s + 1) % Sectors;
                triangles.push({
                    p1: grid[r][s],
                    p2: grid[r+1][s],
                    p3: grid[r+1][sNext]
                });
                triangles.push({
                    p1: grid[r][s],
                    p2: grid[r+1][sNext],
                    p3: grid[r][sNext]
                });
            }
        }

        // Powierzchnia Dolna (Flat Bottom z=0, skierowana w dół)
        const B_center = { lx: 0, ly: 0, z: 0 };
        for (let s = 0; s < Sectors; s++) {
            const sNext = (s + 1) % Sectors;
            triangles.push({
                p1: B_center,
                p2: { lx: grid[Rings][sNext].lx, ly: grid[Rings][sNext].ly, z: 0 },
                p3: { lx: grid[Rings][s].lx, ly: grid[Rings][s].ly, z: 0 }
            });
        }

        // Ściany Boczne (Outer Side Walls)
        for (let s = 0; s < Sectors; s++) {
            const sNext = (s + 1) % Sectors;
            const V_top = grid[Rings][s];
            const V_top_next = grid[Rings][sNext];
            const V_bot = { lx: V_top.lx, ly: V_top.ly, z: 0 };
            const V_bot_next = { lx: V_top_next.lx, ly: V_top_next.ly, z: 0 };

            // Trójkąt 1 (Dół-DółNastępny-GóraNastępny)
            triangles.push({
                p1: V_bot,
                p2: V_bot_next,
                p3: V_top_next
            });
            // Trójkąt 2 (Dół-GóraNastępny-Góra)
            triangles.push({
                p1: V_bot,
                p2: V_top_next,
                p3: V_top
            });
        }

        // 7. Zapis do binarnego bufora STL
        const numTriangles = triangles.length;
        const totalBytes = 80 + 4 + numTriangles * 50;
        const buffer = new ArrayBuffer(totalBytes);
        const view = new DataView(buffer);

        // Header (80 bytes)
        const header = "Created with HexSplitter - 3D Hex Relief Watertight STL";
        for (let i = 0; i < Math.min(80, header.length); i++) {
            view.setUint8(i, header.charCodeAt(i));
        }

        // Triangle count (4 bytes)
        view.setUint32(80, numTriangles, true);

        // Funkcja do obliczania normalnej
        function calculateNormal(p1, p2, p3) {
            const ux = p2.lx - p1.lx;
            const uy = p2.ly - p1.ly;
            const uz = p2.z - p1.z;
            const vx = p3.lx - p1.lx;
            const vy = p3.ly - p1.ly;
            const vz = p3.z - p1.z;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            return len > 0 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 1 };
        }

        let offset = 84;
        for (let i = 0; i < numTriangles; i++) {
            const t = triangles[i];
            const norm = calculateNormal(t.p1, t.p2, t.p3);

            // Zapisz wektor normalny (3x float32)
            view.setFloat32(offset, norm.x, true);
            view.setFloat32(offset + 4, norm.y, true);
            view.setFloat32(offset + 8, norm.z, true);

            // Zapisz Vertex 1
            view.setFloat32(offset + 12, t.p1.lx, true);
            view.setFloat32(offset + 16, t.p1.ly, true);
            view.setFloat32(offset + 20, t.p1.z, true);

            // Zapisz Vertex 2
            view.setFloat32(offset + 24, t.p2.lx, true);
            view.setFloat32(offset + 28, t.p2.ly, true);
            view.setFloat32(offset + 32, t.p2.z, true);

            // Zapisz Vertex 3
            view.setFloat32(offset + 36, t.p3.lx, true);
            view.setFloat32(offset + 40, t.p3.ly, true);
            view.setFloat32(offset + 44, t.p3.z, true);

            // Attribute byte count (2 bytes padding)
            view.setUint16(offset + 48, 0, true);

            offset += 50;
        }

        return buffer;
    }
};

export default STLHexGenerator;
