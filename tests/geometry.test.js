import test from 'node:test';
import assert from 'node:assert/strict';
import HexMath from '../js/hex-math.js';
import GridManager from '../js/grid-manager.js';
import FrameGenerator from '../js/frame-generator.js';
import HangerGenerator from '../js/hanger-generator.js';
import STLHexGenerator from '../js/stl-hex-generator.js';

const RUNTIME_DOCUMENT = globalThis.document;

function makeWhiteCanvasContext() {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255;
    }
    return {
        filter: 'none',
        drawImage() {},
        getImageData() { return { data }; }
    };
}

globalThis.document = {
    createElement(tag) {
        assert.equal(tag, 'canvas');
        return { getContext: () => makeWhiteCanvasContext() };
    }
};

function makeGrid({ orientation = 'flat-top', stagger = 'left', halfHexes = false } = {}) {
    const manager = new GridManager();
    manager.updateConfig({
        columns: 3,
        rows: 3,
        hexSize: 20,
        orientation,
        stagger,
        gap: 2,
        halfHexes,
        frameEnable: false
    });
    return manager;
}

function generateWhiteRelief(manager, cell, options = {}) {
    cell.imageId = 'white-image';
    return STLHexGenerator.generateHexSTL(cell, manager, {
        getImage: () => ({ id: 'white-image' }),
        getRotatedCanvasOrImage: () => ({ image: true })
    }, { sectors: 30, rings: 5, baseThickness: 1.2, reliefHeight: 2, blur: 0, ...options });
}

function parseStl(buffer) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    assert.equal(buffer.byteLength, 84 + count * 50, 'binary STL size matches its triangle count');
    const triangles = [];
    for (let index = 0; index < count; index++) {
        const offset = 84 + index * 50;
        const normal = [0, 1, 2].map(axis => view.getFloat32(offset + axis * 4, true));
        const points = [0, 1, 2].map(point => {
            const start = offset + 12 + point * 12;
            return [0, 1, 2].map(axis => view.getFloat32(start + axis * 4, true));
        });
        triangles.push({ normal, points });
    }
    return triangles;
}

function parseAsciiStl(stl) {
    const normals = [...stl.matchAll(/facet normal ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+)/g)]
        .map(match => match.slice(1).map(Number));
    const vertices = [...stl.matchAll(/vertex ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+)/g)]
        .map(match => match.slice(1).map(Number));
    assert.equal(vertices.length, normals.length * 3, 'ASCII STL has three vertices per facet');
    return normals.map((normal, index) => ({ normal, points: vertices.slice(index * 3, index * 3 + 3) }));
}

function pointKey(point) {
    return point.map(value => Math.round(value * 100000)).join(',');
}

function verifyTriangleMesh(triangles) {
    const edgeCounts = new Map();
    let signedVolume = 0;
    for (const triangle of triangles) {
        const [a, b, c] = triangle.points;
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const length = Math.hypot(...cross);
        assert.ok(length > 1e-7, 'mesh contains no degenerate triangles');
        const computedNormal = cross.map(value => value / length);
        const dot = computedNormal.reduce((sum, value, axis) => sum + value * triangle.normal[axis], 0);
        assert.ok(dot > 0.999, 'stored STL normal matches triangle winding');
        signedVolume += (a[0] * (b[1] * c[2] - b[2] * c[1]) +
            a[1] * (b[2] * c[0] - b[0] * c[2]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;

        for (let edge = 0; edge < 3; edge++) {
            const first = pointKey(triangle.points[edge]);
            const second = pointKey(triangle.points[(edge + 1) % 3]);
            const key = first < second ? `${first}|${second}` : `${second}|${first}`;
            edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        }
    }

    assert.ok(signedVolume > 0, 'closed relief has positive signed volume');
    assert.ok([...edgeCounts.values()].every(count => count === 2), 'each mesh edge belongs to exactly two triangles');
    assert.ok(triangles.some(({ normal }) => normal[2] > 0.99), 'top surfaces face upward');
    assert.ok(triangles.some(({ normal }) => normal[2] < -0.99), 'bottom surfaces face downward');
    return triangles;
}

function verifyClosedOutwardMesh(buffer) {
    return verifyTriangleMesh(parseStl(buffer));
}

function pointOnSegment(point, a, b, epsilon = 1e-4) {
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) > epsilon * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) return false;
    const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
    return dot <= epsilon;
}

function pointInConvexPolygon(point, polygon) {
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
        if (cross < -1e-4 && !pointOnSegment(point, a, b)) return false;
    }
    return true;
}

test('relief STL is closed, outward, and preserves clipped polygon corners for both layouts', () => {
    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            const manager = makeGrid({ orientation, stagger, halfHexes: true });
            const cell = manager.getAllCells()[0];
            const polygon = HexMath.getCellVertices(cell, manager.config);
            assert.ok(polygon.length >= 3, `${orientation}/${stagger} has a clipped polygon`);

            const buffer = generateWhiteRelief(manager, cell);
            assert.ok(buffer instanceof ArrayBuffer);
            const triangles = verifyClosedOutwardMesh(buffer);
            const points = triangles.flatMap(triangle => triangle.points);
            const center = polygon.reduce((sum, point) => ({
                x: sum.x + point.x / polygon.length,
                y: sum.y + point.y / polygon.length
            }), { x: 0, y: 0 });

            for (const point of points) {
                const inWorld = { x: point[0] + center.x, y: -point[1] + center.y };
                assert.ok(pointInConvexPolygon(inWorld, polygon), `${orientation}/${stagger} relief stays within its clipped hex`);
            }
            for (const corner of polygon) {
                assert.ok(points.some(point => Math.hypot(point[0] + center.x - corner.x, -point[1] + center.y - corner.y) < 1e-4),
                    `${orientation}/${stagger} mesh contains each clipped corner`);
            }
        }
    }
});

test('neighbor lookup follows rendered edges for both stagger parities and keeps the legacy default', () => {
    const legacyFlatOffsets = [
        { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
        { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }
    ];
    for (let edge = 0; edge < 6; edge++) assert.deepEqual(HexMath.getNeighborOffset(edge, 'flat-top'), legacyFlatOffsets[edge]);

    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            for (const q of [-1, 0, 1, 2]) {
                for (const r of [-1, 0, 1, 2]) {
                    const center = HexMath.axialToPixel(q, r, 1, orientation, 0, stagger);
                    const vertices = HexMath.getHexVertices(center.x, center.y, 1, orientation);
                    for (let edge = 0; edge < 6; edge++) {
                        const offset = HexMath.getNeighborOffset(edge, orientation, stagger, q, r);
                        const neighborCenter = HexMath.axialToPixel(q + offset.q, r + offset.r, 1, orientation, 0, stagger);
                        const midpoint = {
                            x: (vertices[edge].x + vertices[(edge + 1) % 6].x) / 2,
                            y: (vertices[edge].y + vertices[(edge + 1) % 6].y) / 2
                        };
                        const expected = { x: midpoint.x - center.x, y: midpoint.y - center.y };
                        const actual = { x: neighborCenter.x - center.x, y: neighborCenter.y - center.y };
                        const alignment = (expected.x * actual.x + expected.y * actual.y) / (Math.hypot(expected.x, expected.y) * Math.hypot(actual.x, actual.y));
                        assert.ok(alignment > 0.999999, `${orientation}/${stagger} edge ${edge} maps to the geometrical neighbor`);
                        const reverse = HexMath.getNeighborOffset((edge + 3) % 6, orientation, stagger, q + offset.q, r + offset.r);
                        assert.deepEqual({ q: offset.q + reverse.q, r: offset.r + reverse.r }, { q: 0, r: 0 }, 'neighbor mapping is reciprocal');
                    }
                }
            }
        }
    }

    const rightStaggerGrid = makeGrid({ orientation: 'flat-top', stagger: 'right' });
    const a1 = rightStaggerGrid.getAllCells().find(cell => cell.label === 'A1');
    const a1LowerRight = HexMath.getNeighborOffset(0, 'flat-top', 'right', a1.q, a1.r);
    assert.equal(rightStaggerGrid.getCell(a1.q + a1LowerRight.q, a1.r + a1LowerRight.r).label, 'B2');
    assert.equal(HexMath.isEdgeShared(a1, 0, rightStaggerGrid), true);
});

test('frame STL variants remain closed, outward, and bounded by their exported polygon', () => {
    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            const manager = makeGrid({ orientation, stagger, halfHexes: true });
            const cell = manager.getAllCells()[0];
            const shape = FrameGenerator.getFrameVerticesMm(cell, manager, manager.config.frameWidth, manager.config.frameClearance);
            assert.ok(shape.outerVerticesMm.length >= 3);
            const minX = Math.min(...shape.outerVerticesMm.map(point => point.x));
            const maxX = Math.max(...shape.outerVerticesMm.map(point => point.x));
            const minY = Math.min(...shape.outerVerticesMm.map(point => point.y));
            const maxY = Math.max(...shape.outerVerticesMm.map(point => point.y));
            const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

            for (const type of ['backing', 'outline', 'sleeve']) {
                const stl = FrameGenerator.generateFrameSTL(cell, manager, type, manager.config.frameWidth, manager.config.frameClearance, 10, 1.2);
                const triangles = verifyTriangleMesh(parseAsciiStl(stl));
                for (const point of triangles.flatMap(triangle => triangle.points)) {
                    assert.ok(pointInConvexPolygon({ x: point[0] + center.x, y: -point[1] + center.y }, shape.outerVerticesMm),
                        `${orientation}/${stagger} ${type} mesh remains inside its exported outline`);
                }
            }
        }
    }
});

test('bed checks use the generated frame polygon bounds, including offsets and clipping', () => {
    const manager = new GridManager();
    manager.updateConfig({
        columns: 1,
        rows: 1,
        hexSize: 100,
        orientation: 'flat-top',
        stagger: 'left',
        gap: 0,
        frameEnable: true,
        frameWidth: 2,
        frameClearance: 0.2,
        halfHexes: false,
        bedX: 204.5,
        bedY: 204.5
    });
    const cell = manager.getAllCells()[0];
    const frame = FrameGenerator.getFrameVerticesMm(cell, manager, 2, 0.2);
    const width = Math.max(...frame.outerVerticesMm.map(point => point.x)) - Math.min(...frame.outerVerticesMm.map(point => point.x));
    const height = Math.max(...frame.outerVerticesMm.map(point => point.y)) - Math.min(...frame.outerVerticesMm.map(point => point.y));
    assert.ok(width > 204.5);
    assert.equal(cell.exceedsBedSize, true);

    manager.updateConfig({ bedX: 205.1, bedY: 177.6 });
    assert.equal(manager.getAllCells()[0].exceedsBedSize, false);

    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            manager.updateConfig({ columns: 3, rows: 2, orientation, stagger, halfHexes: true, bedX: width, bedY: height });
            for (const gridCell of manager.getAllCells()) {
                const exported = FrameGenerator.getFrameVerticesMm(gridCell, manager, manager.config.frameWidth, manager.config.frameClearance).outerVerticesMm;
                const bounds = exported.length < 3 ? { width: 0, height: 0 } : {
                    width: Math.max(...exported.map(point => point.x)) - Math.min(...exported.map(point => point.x)),
                    height: Math.max(...exported.map(point => point.y)) - Math.min(...exported.map(point => point.y))
                };
                const shouldExceed = !((bounds.width <= manager.config.bedX && bounds.height <= manager.config.bedY) ||
                    (bounds.height <= manager.config.bedX && bounds.width <= manager.config.bedY));
                assert.equal(gridCell.exceedsBedSize, shouldExceed, `${orientation}/${stagger} status matches exported frame bounds`);
            }
        }
    }
});

test('minimal clipped grids keep valid hexes and empty bounds resolve to zero', () => {
    for (const orientation of ['flat-top', 'pointy-top']) {
        for (const stagger of ['left', 'right']) {
            const manager = new GridManager();
            manager.updateConfig({
                columns: 1,
                rows: 1,
                hexSize: 20,
                orientation,
                stagger,
                gap: 2,
                halfHexes: true,
                frameEnable: false
            });
            const cell = manager.getAllCells()[0];
            const vertices = HexMath.getCellVertices(cell, manager.config);
            assert.equal(vertices.length, 6, `${orientation}/${stagger} 1×1 retains the full hex`);
            const bounds = manager.getBoundingBoxMm();
            assert.ok(bounds.width > 0 && bounds.height > 0);
            assert.deepEqual(manager.getBoundingBoxOfCells([cell]), bounds);
        }
    }

    const flatSingleColumn = makeGrid({ orientation: 'flat-top', stagger: 'right', halfHexes: true });
    flatSingleColumn.updateConfig({ columns: 1, rows: 2 });
    assert.ok(HexMath.getCellVertices(flatSingleColumn.getAllCells()[0], flatSingleColumn.config).length >= 3,
        'a flat-top grid with one column remains clip-able');

    const pointySingleRow = makeGrid({ orientation: 'pointy-top', stagger: 'right', halfHexes: true });
    pointySingleRow.updateConfig({ columns: 2, rows: 1 });
    assert.ok(HexMath.getCellVertices(pointySingleRow.getAllCells()[0], pointySingleRow.config).length >= 3,
        'a pointy-top grid with one row remains clip-able');

    const cell = pointySingleRow.getAllCells()[0];
    pointySingleRow.config.rows = 0;
    const zeroBounds = { width: 0, height: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
    assert.deepEqual(pointySingleRow.getBoundingBoxMm(), zeroBounds);
    assert.deepEqual(pointySingleRow.getBoundingBoxOfCells([cell]), zeroBounds);
});

test('degenerate clipping and out-of-range relief meshes are rejected safely', () => {
    assert.deepEqual(HexMath.clipPolygonToRect([
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }
    ], 1, 2, 0, 1), []);
    assert.deepEqual(HexMath.getOffsetPolygonVertices([], []), []);

    const manager = makeGrid();
    const cell = manager.getAllCells()[0];
    cell.imageId = 'white-image';
    const processor = { getImage: () => ({}), getRotatedCanvasOrImage: () => ({}) };
    assert.equal(STLHexGenerator.generateHexSTL(cell, manager, processor, { sectors: 361 }), null);
    assert.equal(STLHexGenerator.generateHexSTL(cell, manager, processor, { rings: 181 }), null);
    assert.equal(STLHexGenerator.generateHexSTL(cell, manager, processor, { baseThickness: 0 }), null);
    assert.equal(HangerGenerator.generateSTL({ hexSize: 20, gap: 2 }, { armWidth: 0 }), '');
    assert.match(HangerGenerator.generateSTL({ hexSize: 20, gap: 2 }, {}), /^solid symmetric_y_hanger/);
});

test.after(() => {
    if (RUNTIME_DOCUMENT === undefined) delete globalThis.document;
    else globalThis.document = RUNTIME_DOCUMENT;
});
