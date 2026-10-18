import HexMath from './hex-math.js?v=1.0.3';

const MAX_SECTORS = 360;
const MAX_RINGS = 180;
const TAU = Math.PI * 2;

function createSamplingCanvas(factory) {
    if (typeof factory === 'function') return factory(256, 256);
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(256, 256);
    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        return canvas;
    }
    return null;
}

function rayPolygonIntersection(center, angle, vertices) {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    let nearestDistance = Infinity;

    for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ax = a.x - center.x;
        const ay = a.y - center.y;
        const denominator = ux * dy - uy * dx;
        if (Math.abs(denominator) < 1e-12) continue;

        // center + distance * ray = a + t * (b - a)
        const distance = (ax * dy - ay * dx) / denominator;
        const edgeT = (ax * uy - ay * ux) / denominator;
        if (distance >= -1e-9 && edgeT >= -1e-9 && edgeT <= 1 + 1e-9) {
            nearestDistance = Math.min(nearestDistance, Math.max(0, distance));
        }
    }

    if (!Number.isFinite(nearestDistance)) return null;
    return { x: center.x + nearestDistance * ux, y: center.y + nearestDistance * uy };
}

function faceNormal(a, b, c) {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length <= 1e-15) return null;
    return { x: nx / length, y: ny / length, z: nz / length };
}

const STLHexGenerator = {
    /** Generate a binary STL relief for a single assigned hex. */
    generateHexSTL(cell, gridManager, imageProcessor, options = {}) {
        if (!cell?.enabled || !cell.imageId || !gridManager?.config || !imageProcessor) return null;

        const sectors = Number(options.sectors ?? 120);
        const rings = Number(options.rings ?? 60);
        const baseThickness = Number(options.baseThickness ?? 1.2);
        const reliefHeight = Number(options.reliefHeight ?? 2.0);
        const blurRadius = Number(options.blur ?? 1.5);
        if (!Number.isInteger(sectors) || sectors < 3 || sectors > MAX_SECTORS ||
            !Number.isInteger(rings) || rings < 1 || rings > MAX_RINGS ||
            !Number.isFinite(baseThickness) || baseThickness <= 0 || baseThickness > 50 ||
            !Number.isFinite(reliefHeight) || reliefHeight < 0 || reliefHeight > 50 ||
            !Number.isFinite(blurRadius) || blurRadius < 0 || blurRadius > 5) return null;

        const verticesMm = HexMath.getCellVertices(cell, gridManager.config);
        if (verticesMm.length < 3) return null;

        const center = verticesMm.reduce((sum, point) => ({ x: sum.x + point.x / verticesMm.length, y: sum.y + point.y / verticesMm.length }), { x: 0, y: 0 });

        const imageObj = imageProcessor.getImage(cell.imageId);
        if (!imageObj) return null;
        const sourceElement = imageProcessor.getRotatedCanvasOrImage(imageObj);
        if (!sourceElement) return null;

        const sampleCanvas = createSamplingCanvas(options.canvasFactory);
        if (!sampleCanvas) return null;
        const sampleCtx = sampleCanvas.getContext('2d');
        if (!sampleCtx) return null;
        if (blurRadius > 0) sampleCtx.filter = `blur(${blurRadius}px)`;

        const crop = cell.cropRegion;
        if (crop) {
            sampleCtx.drawImage(sourceElement, crop.x, crop.y, crop.w, crop.h, 0, 0, 256, 256);
        } else {
            sampleCtx.drawImage(sourceElement, 0, 0, 256, 256);
        }
        const pixels = sampleCtx.getImageData(0, 0, 256, 256).data;

        const config = gridManager.config;
        const hexSize = Number(config.hexSize);
        const orientation = config.orientation;
        const gap = Number(config.gap ?? 0);
        if (!Number.isFinite(hexSize) || hexSize <= 0 || !Number.isFinite(gap) || gap < 0) return null;
        const hexDimensions = HexMath.getHexDimensions(hexSize, orientation);
        const cellCenter = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, config.stagger || 'left');
        const sourceMinX = cellCenter.x - hexDimensions.width / 2;
        const sourceMinY = cellCenter.y - hexDimensions.height / 2;

        const sampleHeight = (x, y) => {
            const u = Math.max(0, Math.min(1, (x - sourceMinX) / hexDimensions.width));
            const v = Math.max(0, Math.min(1, (y - sourceMinY) / hexDimensions.height));
            const pixelIndex = (Math.round(v * 255) * 256 + Math.round(u * 255)) * 4;
            const alpha = pixels[pixelIndex + 3];
            if (alpha < 30) return 0;
            const luminance = 0.299 * pixels[pixelIndex] + 0.587 * pixels[pixelIndex + 1] + 0.114 * pixels[pixelIndex + 2];
            const factor = options.invert ? 1 - luminance / 255 : luminance / 255;
            return factor * reliefHeight;
        };

        // Include every polygon corner in the radial mesh. Uniform sectors alone
        // miss corners whenever their angle does not land on a sector boundary.
        const angles = Array.from({ length: sectors }, (_, i) => i * TAU / sectors);
        for (const vertex of verticesMm) {
            const angle = (Math.atan2(vertex.y - center.y, vertex.x - center.x) + TAU) % TAU;
            angles.push(angle);
        }
        angles.sort((a, b) => a - b);
        const uniqueAngles = angles.filter((angle, index) => index === 0 || angle - angles[index - 1] > 1e-10);
        if (uniqueAngles.length > 1 && uniqueAngles[0] + TAU - uniqueAngles[uniqueAngles.length - 1] <= 1e-10) uniqueAngles.pop();
        if (uniqueAngles.length > MAX_SECTORS + 12) return null;

        const centerHeight = baseThickness + sampleHeight(center.x, center.y);
        const grid = new Array(rings + 1);
        grid[0] = [{ x: 0, y: 0, z: centerHeight }];
        for (let ring = 1; ring <= rings; ring++) {
            const fraction = ring / rings;
            const ringVertices = new Array(uniqueAngles.length);
            for (let sector = 0; sector < uniqueAngles.length; sector++) {
                const boundary = rayPolygonIntersection(center, uniqueAngles[sector], verticesMm);
                if (!boundary) return null;
                const x = center.x + fraction * (boundary.x - center.x);
                const y = center.y + fraction * (boundary.y - center.y);
                ringVertices[sector] = {
                    x: x - center.x,
                    y: -(y - center.y),
                    z: baseThickness + sampleHeight(x, y)
                };
            }
            grid[ring] = ringVertices;
        }

        const sectorCount = uniqueAngles.length;
        const triangleCount = sectorCount * (2 * rings + 2);
        const buffer = new ArrayBuffer(84 + triangleCount * 50);
        const view = new DataView(buffer);
        const header = 'Created with HexSplitter - 3D Hex Relief Watertight STL';
        for (let i = 0; i < Math.min(80, header.length); i++) view.setUint8(i, header.charCodeAt(i));
        view.setUint32(80, triangleCount, true);

        let offset = 84;
        let writtenTriangles = 0;
        const writeTriangle = (a, b, c) => {
            const normal = faceNormal(a, b, c);
            if (!normal) throw new Error('Relief mesh contains a degenerate triangle.');
            view.setFloat32(offset, normal.x, true);
            view.setFloat32(offset + 4, normal.y, true);
            view.setFloat32(offset + 8, normal.z, true);
            const writePoint = (point, vertexOffset) => {
                view.setFloat32(vertexOffset, point.x, true);
                view.setFloat32(vertexOffset + 4, point.y, true);
                view.setFloat32(vertexOffset + 8, point.z, true);
            };
            writePoint(a, offset + 12);
            writePoint(b, offset + 24);
            writePoint(c, offset + 36);
            view.setUint16(offset + 48, 0, true);
            offset += 50;
            writtenTriangles++;
        };

        // Top fan and rings: reverse XY winding because STL's local Y axis is flipped.
        for (let sector = 0; sector < sectorCount; sector++) {
            const next = (sector + 1) % sectorCount;
            writeTriangle(grid[0][0], grid[1][next], grid[1][sector]);
        }
        for (let ring = 1; ring < rings; ring++) {
            for (let sector = 0; sector < sectorCount; sector++) {
                const next = (sector + 1) % sectorCount;
                writeTriangle(grid[ring][sector], grid[ring + 1][next], grid[ring + 1][sector]);
                writeTriangle(grid[ring][sector], grid[ring][next], grid[ring + 1][next]);
            }
        }

        const bottomCenter = { x: 0, y: 0, z: 0 };
        for (let sector = 0; sector < sectorCount; sector++) {
            const next = (sector + 1) % sectorCount;
            const current = grid[rings][sector];
            const nextVertex = grid[rings][next];
            writeTriangle(bottomCenter, { x: current.x, y: current.y, z: 0 }, { x: nextVertex.x, y: nextVertex.y, z: 0 });
        }

        // Side walls follow the clockwise outer boundary and face outward.
        for (let sector = 0; sector < sectorCount; sector++) {
            const next = (sector + 1) % sectorCount;
            const top = grid[rings][sector];
            const topNext = grid[rings][next];
            const bottom = { x: top.x, y: top.y, z: 0 };
            const bottomNext = { x: topNext.x, y: topNext.y, z: 0 };
            writeTriangle(bottom, topNext, bottomNext);
            writeTriangle(bottom, top, topNext);
        }

        if (writtenTriangles !== triangleCount) throw new Error('Relief STL triangle count mismatch.');
        return buffer;
    }
};

export default STLHexGenerator;
