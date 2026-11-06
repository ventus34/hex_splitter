import HexMath from './hex-math.js';
import { arePanelCellsConnected, resolveGroupCells } from './panel-groups.js';

const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

function panelError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** Preserve each planned polygon, including clipping, while changing center spacing. */
export function getPanelGeometry(group, grid, gapMm = grid.panelExport?.gapMm ?? 0) {
    if (!Number.isFinite(gapMm) || gapMm < 0 || gapMm > 50) throw panelError('PANEL_INVALID_GAP', 'Invalid panel gap.');
    const members = resolveGroupCells(group, grid);
    if (members.length < 2 || members.some(cell => !cell?.enabled) ||
        new Set(members.map(cell => `${cell.q},${cell.r}`)).size !== members.length ||
        !arePanelCellsConnected(members, grid.config)) {
        throw panelError('PANEL_INVALID_CELLS', 'Panel hexes must be active and connected.');
    }
    const { hexSize, orientation, stagger = 'left', gap = 0 } = grid.config;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const cells = members.map(cell => {
        const oldCenter = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        const center = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gapMm, stagger);
        const vertices = HexMath.getCellVertices(cell, grid.config).map(vertex => ({
            x: vertex.x - oldCenter.x + center.x,
            y: vertex.y - oldCenter.y + center.y
        }));
        if (vertices.length < 3) throw panelError('PANEL_INVALID_CELLS', 'A panel hex has no visible area.');
        for (const vertex of vertices) {
            minX = Math.min(minX, vertex.x); maxX = Math.max(maxX, vertex.x);
            minY = Math.min(minY, vertex.y); maxY = Math.max(maxY, vertex.y);
        }
        return { cell, center, vertices };
    });
    const bbox = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    if (!Number.isFinite(bbox.width) || !Number.isFinite(bbox.height) || bbox.width <= 0 || bbox.height <= 0) {
        throw panelError('PANEL_INVALID_CELLS', 'Panel geometry is empty.');
    }
    return { cells, bbox };
}

/** One scale for the entire panel; actual axes cover the exact physical bbox. */
export function getPanelRaster(geometry, grid) {
    const config = grid.config;
    const dimensions = HexMath.getHexDimensions(config.hexSize, config.orientation);
    const scale = config.dpi === 'original'
        ? Math.max(...geometry.cells.map(({ cell }) => cell.cropRegion
            ? cell.cropRegion.w / dimensions.width
            : HexMath.mmToPixels(1, 300)))
        : HexMath.mmToPixels(1, Number(config.dpi));
    const width = Math.round(geometry.bbox.width * scale);
    const height = Math.round(geometry.bbox.height * scale);
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_PIXELS) {
        throw panelError('PANEL_EXPORT_TOO_LARGE', 'Panel image exceeds the canvas size limit.');
    }
    return { width, height, scale };
}

export function panelFilename(geometry) {
    const labels = [...geometry.cells]
        .sort((a, b) => a.cell.col - b.cell.col || a.cell.row - b.cell.row)
        .map(({ cell }) => cell.label);
    return `panel_${labels.join('_')}_${geometry.bbox.width.toFixed(2)}x${geometry.bbox.height.toFixed(2)}mm.png`;
}

/** Extend image edges without ever allocating a copy of the entire source image.
 * The temporary texture is restricted to the tile's visible area and resolution. */
function drawExtendedImage(ctx, source, crop, left, top, width, height, tileBounds) {
    const sourceWidth = source.naturalWidth || source.width;
    const sourceHeight = source.naturalHeight || source.height;
    if (![sourceWidth, sourceHeight, crop.x, crop.y, crop.w, crop.h, width, height].every(Number.isFinite) ||
        sourceWidth <= 0 || sourceHeight <= 0 || crop.w <= 0 || crop.h <= 0 || width <= 0 || height <= 0) {
        throw panelError('PANEL_MISSING_IMAGE', 'The panel source image is invalid.');
    }
    const extraX = 2 * crop.w / width, extraY = 2 * crop.h / height;
    const startX = crop.x - extraX, startY = crop.y - extraY;
    const endX = crop.x + crop.w + extraX, endY = crop.y + crop.h + extraY;
    // Most crops have source pixels outside their edges, requiring no texture.
    if (startX >= 0 && startY >= 0 && endX <= sourceWidth && endY <= sourceHeight) {
        ctx.drawImage(source, startX, startY, endX - startX, endY - startY, left - 2, top - 2, width + 4, height + 4);
        return;
    }
    const visibleStartX = Math.max(startX, crop.x + (tileBounds.x - left - 2) * crop.w / width);
    const visibleStartY = Math.max(startY, crop.y + (tileBounds.y - top - 2) * crop.h / height);
    const visibleEndX = Math.min(endX, crop.x + (tileBounds.x + tileBounds.width - left + 2) * crop.w / width);
    const visibleEndY = Math.min(endY, crop.y + (tileBounds.y + tileBounds.height - top + 2) * crop.h / height);
    const roiX = Math.max(0, Math.floor(visibleStartX - 1));
    const roiY = Math.max(0, Math.floor(visibleStartY - 1));
    const roiEndX = Math.min(sourceWidth, Math.ceil(visibleEndX + 1));
    const roiEndY = Math.min(sourceHeight, Math.ceil(visibleEndY + 1));
    if (roiX >= roiEndX || roiY >= roiEndY) return;
    const roiWidth = roiEndX - roiX, roiHeight = roiEndY - roiY;
    // No more than one texture pixel per output pixel. Rounding dimensions only
    // changes sampling resolution, never the crop-to-panel transform.
    const textureWidth = Math.max(1, Math.ceil(roiWidth * Math.min(1, width / crop.w)));
    const textureHeight = Math.max(1, Math.ceil(roiHeight * Math.min(1, height / crop.h)));
    const scaleX = textureWidth / roiWidth, scaleY = textureHeight / roiHeight;
    const leftEdge = roiX === 0 && crop.x >= 0;
    const rightEdge = roiEndX === sourceWidth && crop.x + crop.w <= sourceWidth;
    const topEdge = roiY === 0 && crop.y >= 0;
    const bottomEdge = roiEndY === sourceHeight && crop.y + crop.h <= sourceHeight;
    const padLeft = leftEdge ? Math.ceil((extraX + 2) * scaleX) + 1 : 0;
    const padRight = rightEdge ? Math.ceil((extraX + 2) * scaleX) + 1 : 0;
    const padTop = topEdge ? Math.ceil((extraY + 2) * scaleY) + 1 : 0;
    const padBottom = bottomEdge ? Math.ceil((extraY + 2) * scaleY) + 1 : 0;
    const padded = document.createElement('canvas');
    padded.width = padLeft + textureWidth + padRight;
    padded.height = padTop + textureHeight + padBottom;
    const padCtx = padded.getContext('2d');
    if (!padCtx) throw panelError('PANEL_EXPORT_FAILED', 'Canvas rendering is unavailable.');
    try {
        padCtx.drawImage(source, roiX, roiY, roiWidth, roiHeight, padLeft, padTop, textureWidth, textureHeight);
        // Stretch edge pixels into the texture margin at integer coordinates, so
        // neighboring rectangles meet without introducing another alpha seam.
        if (leftEdge) padCtx.drawImage(source, roiX, roiY, 1, roiHeight, 0, padTop, padLeft, textureHeight);
        if (rightEdge) padCtx.drawImage(source, roiEndX - 1, roiY, 1, roiHeight, padLeft + textureWidth, padTop, padRight, textureHeight);
        if (topEdge) padCtx.drawImage(source, roiX, roiY, roiWidth, 1, padLeft, 0, textureWidth, padTop);
        if (bottomEdge) padCtx.drawImage(source, roiX, roiEndY - 1, roiWidth, 1, padLeft, padTop + textureHeight, textureWidth, padBottom);
        if (leftEdge && topEdge) padCtx.drawImage(source, roiX, roiY, 1, 1, 0, 0, padLeft, padTop);
        if (rightEdge && topEdge) padCtx.drawImage(source, roiEndX - 1, roiY, 1, 1, padLeft + textureWidth, 0, padRight, padTop);
        if (leftEdge && bottomEdge) padCtx.drawImage(source, roiX, roiEndY - 1, 1, 1, 0, padTop + textureHeight, padLeft, padBottom);
        if (rightEdge && bottomEdge) padCtx.drawImage(source, roiEndX - 1, roiEndY - 1, 1, 1, padLeft + textureWidth, padTop + textureHeight, padRight, padBottom);
        ctx.drawImage(padded, (startX - roiX) * scaleX + padLeft, (startY - roiY) * scaleY + padTop,
            (endX - startX) * scaleX, (endY - startY) * scaleY, left - 2, top - 2, width + 4, height + 4);
    } finally {
        padded.width = 0; padded.height = 0;
    }
}

/** Render all cell crops at a shared mm-to-raster transform. */
export function renderPanelCanvas(group, grid, processor, gapMm = grid.panelExport?.gapMm ?? 0) {
    const geometry = getPanelGeometry(group, grid, gapMm);
    const raster = getPanelRaster(geometry, grid);
    const sources = geometry.cells.map(({ cell }) => {
        const image = cell.imageId && processor.getImage(cell.imageId);
        if (!image) throw panelError('PANEL_MISSING_IMAGE', `Missing image for ${cell.label}.`);
        const source = processor.getRotatedCanvasOrImage(image);
        if (!source) throw panelError('PANEL_MISSING_IMAGE', `Missing image for ${cell.label}.`);
        return source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw panelError('PANEL_EXPORT_FAILED', 'Canvas rendering is unavailable.');
    const { bbox } = geometry;
    const pxX = x => (x - bbox.minX) * raster.width / bbox.width;
    const pxY = y => (y - bbox.minY) * raster.height / bbox.height;
    const { width: hexWidth, height: hexHeight } = HexMath.getHexDimensions(grid.config.hexSize, grid.config.orientation);

    try {
        geometry.cells.forEach(({ cell, center, vertices }, index) => {
            const xs = vertices.map(vertex => pxX(vertex.x));
            const ys = vertices.map(vertex => pxY(vertex.y));
            // Scratch pixels are aligned to the panel's pixel grid, so hexagon
            // placement and sampling are never rounded independently. The margin
            // keeps the scratch image edge outside the antialiased polygon mask.
            const tileX = Math.floor(Math.min(...xs)) - 2;
            const tileY = Math.floor(Math.min(...ys)) - 2;
            const tileWidth = Math.ceil(Math.max(...xs)) - tileX + 2;
            const tileHeight = Math.ceil(Math.max(...ys)) - tileY + 2;
            const tile = document.createElement('canvas');
            tile.width = tileWidth; tile.height = tileHeight;
            try {
                const tileCtx = tile.getContext('2d');
                if (!tileCtx) throw panelError('PANEL_EXPORT_FAILED', 'Canvas rendering is unavailable.');
                tileCtx.globalCompositeOperation = 'lighter';
                tileCtx.translate(-tileX, -tileY);
                const crop = cell.cropRegion;
                if (crop) {
                    const left = pxX(center.x - hexWidth / 2);
                    const top = pxY(center.y - hexHeight / 2);
                    const right = pxX(center.x + hexWidth / 2);
                    const bottom = pxY(center.y + hexHeight / 2);
                    drawExtendedImage(tileCtx, sources[index], crop, left, top, right - left, bottom - top,
                        { x: tileX, y: tileY, width: tileWidth, height: tileHeight });
                } else {
                    // Match ImageProcessor's fallback for an uncropped clipped cell.
                    const left = Math.min(...xs), right = Math.max(...xs);
                    const top = Math.min(...ys), bottom = Math.max(...ys);
                    const source = sources[index];
                    drawExtendedImage(tileCtx, source, { x: 0, y: 0, w: source.naturalWidth || source.width, h: source.naturalHeight || source.height },
                        left, top, right - left, bottom - top, { x: tileX, y: tileY, width: tileWidth, height: tileHeight });
                }
                // Apply coverage on the transparent tile first. Compositing a clipped
                // image directly with lighter can interpolate against the existing
                // destination and leave translucent seams at a shared edge.
                tileCtx.globalCompositeOperation = 'destination-in';
                tileCtx.fillStyle = '#fff';
                tileCtx.beginPath();
                vertices.forEach((point, vertexIndex) => {
                    if (vertexIndex === 0) tileCtx.moveTo(pxX(point.x), pxY(point.y));
                    else tileCtx.lineTo(pxX(point.x), pxY(point.y));
                });
                tileCtx.closePath();
                tileCtx.fill();
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.drawImage(tile, tileX, tileY);
                ctx.restore();
            } finally {
                tile.width = 0; tile.height = 0;
            }
        });
        return canvas;
    } catch (error) {
        canvas.width = 0; canvas.height = 0;
        throw error;
    }
}
