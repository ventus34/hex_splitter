import test from 'node:test';
import assert from 'node:assert/strict';
import GridManager from '../js/grid-manager.js';
import HexMath from '../js/hex-math.js';
import { getPanelGeometry, getPanelRaster, panelFilename, renderPanelCanvas } from '../js/panel-export.js';

const close = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

function setup(orientation = 'flat-top', stagger = 'left', halfHexes = false) {
    const grid = new GridManager();
    grid.updateConfig({ columns: 4, rows: 4, orientation, stagger, hexSize: 20, gap: 3, dpi: 150, halfHexes });
    const first = grid.getCell(0, 0);
    const second = orientation === 'flat-top' ? grid.getCell(0, 1) : grid.getCell(1, 0);
    first.imageId = 'first'; second.imageId = 'second';
    first.cropRegion = { x: 5, y: 10, w: 100, h: 80 };
    second.cropRegion = { x: 20, y: 40, w: 200, h: 160 };
    const group = { id: 'panel_1', cells: [second, first].map(({ q, r }) => ({ q, r })) };
    return { grid, first, second, group };
}

for (const orientation of ['flat-top', 'pointy-top']) {
    for (const stagger of ['left', 'right']) {
        test(`geometry uses panel gap for ${orientation} / ${stagger}`, () => {
            const { grid, group } = setup(orientation, stagger);
            const zero = getPanelGeometry(group, grid, 0);
            const gapped = getPanelGeometry(group, grid, 2.5);
            // Axis-aligned neighbor: both cells have a full hex in their common extent.
            if (orientation === 'flat-top') {
                close(zero.bbox.width, 40);
                close(zero.bbox.height, 2 * Math.sqrt(3) * 20);
                close(gapped.bbox.height - zero.bbox.height, 2.5);
            } else {
                close(zero.bbox.width, 2 * Math.sqrt(3) * 20);
                close(zero.bbox.height, 40);
                close(gapped.bbox.width - zero.bbox.width, 2.5);
            }
            assert.match(panelFilename(zero), /^panel_A1_(?:A2|B1)_\d+\.\d{2}x\d+\.\d{2}mm\.png$/);
            const raster = getPanelRaster(gapped, grid);
            assert.equal(raster.width, Math.round(gapped.bbox.width * 150 / 25.4));
            assert.equal(raster.height, Math.round(gapped.bbox.height * 150 / 25.4));
        });
    }
}

test('clipped original polygons retain their local geometry when panel gap changes', () => {
    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            const { grid, group } = setup(orientation, stagger, true);
            const panel = getPanelGeometry(group, grid, 0);
            for (const member of panel.cells) {
                const oldCenter = HexMath.axialToPixel(member.cell.q, member.cell.r, grid.config.hexSize, orientation, grid.config.gap, stagger);
                const original = HexMath.getCellVertices(member.cell, grid.config);
                assert.equal(original.length, member.vertices.length);
                original.forEach((point, index) => {
                    close(point.x - oldCenter.x, member.vertices[index].x - member.center.x);
                    close(point.y - oldCenter.y, member.vertices[index].y - member.center.y);
                });
            }
        }
    }
});

test('original chooses the highest native crop density and enforces canvas limits', () => {
    const { grid, group, first, second } = setup();
    grid.config.dpi = 'original';
    const geometry = getPanelGeometry(group, grid, 0);
    close(getPanelRaster(geometry, grid).scale, 200 / 40);
    second.cropRegion = null;
    close(getPanelRaster(geometry, grid).scale, 300 / 25.4);
    first.cropRegion.w = 10000000;
    assert.throws(() => getPanelRaster(geometry, grid), { code: 'PANEL_EXPORT_TOO_LARGE' });
});

test('renderer applies crops and additive clipped drawing on a common raster', t => {
    const { grid, group } = setup();
    const calls = [];
    const ctx = {
        save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, translate() {}, fill() {},
        moveTo(x, y) { calls.push(['move', x, y]); }, lineTo() {},
        drawImage(...args) { calls.push(['image', this.globalCompositeOperation, ...args]); }
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
    const processor = {
        getImage(id) { return { id, width: 1000, height: 1000 }; },
        getRotatedCanvasOrImage(image) { return image; }
    };
    const canvas = renderPanelCanvas(group, grid, processor, 0);
    const raster = getPanelRaster(getPanelGeometry(group, grid, 0), grid);
    assert.equal(canvas.width, raster.width); assert.equal(canvas.height, raster.height);
    const images = calls.filter(call => call[0] === 'image' && call[2].id);
    assert.equal(images.length, 2);
    assert.equal(images[0][1], 'lighter');
    // Expanded source still maps the exact crop onto the physical hex bounds.
    const geometry = getPanelGeometry(group, grid, 0);
    const dim = HexMath.getHexDimensions(grid.config.hexSize, grid.config.orientation);
    images.forEach((draw, index) => {
        const [, , , sx, sy, sw, sh, dx, dy, dw, dh] = draw;
        const { cell, center } = geometry.cells[index];
        const mappedLeft = dx + (cell.cropRegion.x - sx) * dw / sw;
        const mappedTop = dy + (cell.cropRegion.y - sy) * dh / sh;
        close(mappedLeft, (center.x - dim.width / 2 - geometry.bbox.minX) * raster.width / geometry.bbox.width);
        close(mappedTop, (center.y - dim.height / 2 - geometry.bbox.minY) * raster.height / geometry.bbox.height);
    });
    assert.throws(() => renderPanelCanvas(group, grid, { getImage: () => null }, 0), { code: 'PANEL_MISSING_IMAGE' });
});

test('all six neighbor directions use the requested edge gap at both parities', () => {
    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            const { grid } = setup(orientation, stagger);
            for (const parity of [0, 1]) {
                const first = grid.getAllCells().find(cell => cell.col === 1 + parity && cell.row === 1 + parity);
                for (let edge = 0; edge < 6; edge++) {
                    const offset = HexMath.getNeighborOffset(edge, orientation, stagger, first.q, first.r);
                    const second = grid.getCell(first.q + offset.q, first.r + offset.r);
                    assert.ok(second, `neighbor ${edge} exists`);
                    const group = { cells: [first, second] };
                    const geometry = getPanelGeometry(group, grid, 1.25);
                    const [a, b] = geometry.cells.map(item => item.center);
                    close(Math.hypot(a.x - b.x, a.y - b.y), Math.sqrt(3) * 20 + 1.25);
                }
            }
        }
    }
});
