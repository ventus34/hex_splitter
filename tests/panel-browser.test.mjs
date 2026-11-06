import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { createStaticServer } from '../server/static-server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="90" fill="red"/><rect y="90" width="120" height="90" fill="blue"/></svg>');
let server, browser, baseUrl, context, page, dialogs;

before(async () => {
    server = createStaticServer({ root: repoRoot });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const options = { headless: true };
    if (process.env.CHROME_CHANNEL) options.channel = process.env.CHROME_CHANNEL;
    browser = await chromium.launch(options);
});

after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
});

beforeEach(async () => {
    dialogs = [];
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ready();
    await captureDownloads();
});

afterEach(async () => { await context?.close(); });

async function ready() {
    await page.waitForFunction(() => window.canEditProject?.() && window.planner && window.gridManager?.getAllCells().length > 0);
    await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
}

async function captureDownloads() {
    await page.evaluate(() => {
        window.__downloads = [];
        window.saveAs = (blob, filename) => window.__downloads.push({ blob, filename });
    });
}

async function setNumber(selector, value) {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).dispatchEvent('input', { bubbles: true });
    if (selector === '#panel-gap-mm') await page.locator(selector).dispatchEvent('change', { bubbles: true });
}

async function selectCell(label) {
    const point = await page.evaluate(async name => {
        const { default: HexMath } = await import('/js/hex-math.js');
        const cell = window.gridManager.getAllCells().find(entry => entry.label === name);
        if (!cell) throw new Error(`Missing cell ${name}`);
        const { hexSize, orientation, gap, stagger } = window.gridManager.config;
        const center = HexMath.axialToPixel(cell.q, cell.r, hexSize, orientation, gap, stagger);
        return window.planner.worldToScreen(center.x, center.y);
    }, label);
    const canvas = page.locator('#planner-canvas');
    const bounds = await canvas.boundingBox();
    assert.ok(bounds, 'planner canvas exists');
    await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
}

async function makeGroup(labels) {
    await page.locator('#btn-mode-groups').click();
    for (const label of labels) await selectCell(label);
    await page.locator('#btn-panel-save').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups.length > 0, undefined, { timeout: 6000 }).catch(async error => {
        const info = await page.evaluate(() => ({ selected: [...window.panelController.selected], mode: window.planner.interactionMode, message: document.querySelector('#panel-group-message').textContent, cells: window.gridManager.getAllCells().map(c => ({ label: c.label, enabled: c.enabled })) }));
        throw new Error(`${error.message}; panel state: ${JSON.stringify(info)}`);
    });
}

async function download(index) {
    await page.waitForFunction(i => window.__downloads?.length > i, index, { timeout: 15000 });
    const result = await page.evaluate(async i => ({
        filename: window.__downloads[i].filename,
        bytes: Array.from(new Uint8Array(await window.__downloads[i].blob.arrayBuffer()))
    }), index);
    return { filename: result.filename, bytes: Buffer.from(result.bytes) };
}

async function importProject(name, bytes) {
    await page.locator('#project-file-input').setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
}

// Sample the actual browser canvas, including subpixel clipping and compositing.
test('panel renderer preserves source crops and transparent spacing without seams at zero gap', async () => {
    const result = await page.evaluate(async () => {
        const { default: GridManager } = await import('/js/grid-manager.js');
        const { getPanelGeometry, getPanelRaster, renderPanelCanvas } = await import('/js/panel-export.js');
        const grid = new GridManager();
        grid.updateConfig({ columns: 1, rows: 2, hexSize: 10, dpi: 300, gap: 2, orientation: 'flat-top' });
        const [a, b] = grid.getAllCells();
        const image = document.createElement('canvas');
        image.width = 120; image.height = 60;
        const source = image.getContext('2d');
        source.fillStyle = '#f00'; source.fillRect(0, 0, 60, 60);
        source.fillStyle = '#00f'; source.fillRect(60, 0, 60, 60);
        a.imageId = b.imageId = 'fixture';
        a.cropRegion = { x: 0, y: 0, w: 60, h: 60 };
        b.cropRegion = { x: 60, y: 0, w: 60, h: 60 };
        const processor = { getImage: id => id === 'fixture' ? { imgElement: image } : null, getRotatedCanvasOrImage: item => item.imgElement };
        const group = { id: 'test', cells: [{ q: a.q, r: a.r }, { q: b.q, r: b.r }] };
        const geometry = getPanelGeometry(group, grid, 0);
        const raster = getPanelRaster(geometry, grid);
        const canvas = renderPanelCanvas(group, grid, processor, 0);
        const ctx = canvas.getContext('2d');
        const x = Math.floor(canvas.width / 2);
        const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
        const middle = Math.round(canvas.height / 2);
        const touching = [middle - 1, middle, middle + 1].map(y => pixel(x, y));
        const separated = renderPanelCanvas(group, grid, processor, 3);
        const gap = [...separated.getContext('2d').getImageData(Math.floor(separated.width / 2), Math.floor(separated.height / 2), 1, 1).data];
        source.clearRect(0, 0, 120, 60);
        source.fillStyle = 'rgba(255,0,0,0.5)'; source.fillRect(0, 0, 60, 60);
        source.fillStyle = 'rgba(0,0,255,0.5)'; source.fillRect(60, 0, 60, 60);
        const translucent = renderPanelCanvas(group, grid, processor, 0);
        const translucentCtx = translucent.getContext('2d');
        const translucentAlpha = [Math.floor(translucent.height / 4), middle - 1, middle, middle + 1].map(y => translucentCtx.getImageData(x, y, 1, 1).data[3]);
        return {
            width: canvas.width, height: canvas.height, raster,
            corner: pixel(0, 0), first: pixel(x, Math.floor(canvas.height / 4)),
            second: pixel(x, Math.floor(canvas.height * 3 / 4)), touching, gap, translucentAlpha
        };
    });
    assert.equal(result.width, result.raster.width);
    assert.equal(result.height, result.raster.height);
    assert.equal(result.corner[3], 0, 'outside the hexagons must remain transparent');
    assert.ok(result.first[0] > 240 && result.first[2] < 10 && result.first[3] === 255);
    assert.ok(result.second[2] > 240 && result.second[0] < 10 && result.second[3] === 255);
    assert.ok(result.touching.every(pixel => pixel[3] >= 250), `transparent seam at shared edge: ${JSON.stringify(result.touching)}`);
    assert.equal(result.gap[3], 0, 'the separate 3 mm gap must be transparent');
    assert.ok(result.translucentAlpha.every(alpha => Math.abs(alpha - 128) <= 3), `source alpha changed at shared edge: ${result.translucentAlpha}`);
});

test('group editing, undo/redo, span mode and disabling a member preserve correct project state', async () => {
    await setNumber('#grid-cols', 1);
    await setNumber('#grid-rows', 3);
    await page.waitForFunction(() => window.gridManager.config.columns === 1 && window.gridManager.config.rows === 3);
    await makeGroup(['A1', 'A2']);
    assert.deepEqual(await page.evaluate(() => window.gridManager.getAllCells().map(cell => cell.enabled)), [true, true, true]);
    assert.equal(await page.locator('.panel-group-row').count(), 1);
    await page.locator('.panel-group-row [data-action="edit"]').click();
    await selectCell('A3');
    await page.locator('#btn-panel-save').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups[0]?.cells.length === 3);
    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups[0]?.cells.length === 2);
    await page.locator('#btn-redo').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups[0]?.cells.length === 3);
    const group = await page.evaluate(() => structuredClone(window.gridManager.panelExport.groups));
    await page.locator('input[name="image-mode"][value="span"]').locator('..').click();
    assert.deepEqual(await page.evaluate(() => window.gridManager.panelExport.groups), group);
    await page.locator('#btn-mode-grid').click();
    await selectCell('A2');
    await page.waitForFunction(() => window.gridManager.panelExport.groups.length === 0);
    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups[0]?.cells.length === 3);
    assert.equal(await page.evaluate(() => window.gridManager.getAllCells().find(cell => cell.label === 'A2').enabled), true);
    await page.locator('.panel-group-row [data-action="delete"]').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups.length === 0);
    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups[0]?.cells.length === 3);
});

test('exported PNG ZIP and project archive preserve groups, independent gap, and compatibility with older projects', async () => {
    await setNumber('#grid-cols', 1);
    await setNumber('#grid-rows', 2);
    await setNumber('#hex-size', 20);
    await page.locator('#export-dpi').selectOption('72');
    await page.locator('#file-input').setInputFiles({ name: 'panel.svg', mimeType: 'image/svg+xml', buffer: fixture });
    await page.waitForFunction(() => window.gridManager.getActiveCells().length === 2 && window.gridManager.getActiveCells().every(cell => cell.imageId));
    await makeGroup(['A1', 'A2']);
    await setNumber('#panel-gap-mm', 1.25);
    await page.waitForFunction(() => window.gridManager.panelExport.gapMm === 1.25);
    await page.locator('#btn-export-groups').click();
    const pngZip = await download(0);
    assert.equal(pngZip.filename, 'hexsplitter_panels.zip');
    const zip = await JSZip.loadAsync(pngZip.bytes, { checkCRC32: true });
    const files = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    assert.deepEqual(files, ['panel_A1_A2_40.00x70.53mm.png']);
    const png = await zip.file(files[0]).async('nodebuffer');
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), Math.round(40 * 72 / 25.4));
    assert.equal(png.readUInt32BE(20), Math.round((2 * Math.sqrt(3) * 20 + 1.25) * 72 / 25.4));
    assert.equal(png[25], 6, 'PNG must retain an alpha channel');

    await page.locator('#btn-save-project').click();
    const saved = await download(1);
    const projectZip = await JSZip.loadAsync(saved.bytes);
    const manifest = JSON.parse(await projectZip.file('project.json').async('text'));
    assert.equal(manifest.layout.panelExport.gapMm, 1.25);
    assert.equal(manifest.layout.panelExport.groups[0].cells.length, 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    assert.deepEqual(await page.evaluate(() => window.gridManager.panelExport), manifest.layout.panelExport);
    await page.locator('.panel-group-row [data-action="delete"]').click();
    await page.waitForFunction(() => window.gridManager.panelExport.groups.length === 0);
    await importProject('panel.hexproj', saved.bytes);
    await page.waitForFunction(() => window.gridManager?.panelExport?.groups.length === 1 && window.gridManager.panelExport.gapMm === 1.25);

    // A schema-2 archive made before panel groups existed remains importable.
    delete manifest.layout.panelExport;
    projectZip.file('project.json', JSON.stringify(manifest));
    const legacy = await projectZip.generateAsync({ type: 'nodebuffer' });
    await importProject('legacy.hexproj', legacy);
    await page.waitForFunction(() => window.gridManager?.panelExport?.groups.length === 0 && window.gridManager.panelExport.gapMm === 0);
    assert.deepEqual(dialogs, []);
});

test('zero-gap diagonal and straight shared edges remain opaque for both orientations and staggers', async () => {
    const failures = await page.evaluate(async () => {
        const { default: GridManager } = await import('/js/grid-manager.js');
        const { default: HexMath } = await import('/js/hex-math.js');
        const { getPanelGeometry, renderPanelCanvas } = await import('/js/panel-export.js');
        const source = document.createElement('canvas');
        source.width = source.height = 50;
        source.getContext('2d').fillRect(0, 0, 50, 50);
        const processor = { getImage: () => ({ imgElement: source }), getRotatedCanvasOrImage: image => image.imgElement };
        const failures = [];
        let checked = 0;
        for (const orientation of ['flat-top', 'pointy-top']) for (const stagger of ['left', 'right']) {
            const grid = new GridManager();
            grid.updateConfig({ columns: 3, rows: 3, hexSize: 20, dpi: 150, orientation, stagger, gap: 2 });
            const first = grid.getAllCells().find(cell => cell.col === 1 && cell.row === 1);
            for (let edge = 0; edge < 6; edge++) {
                const offset = HexMath.getNeighborOffset(edge, orientation, stagger, first.q, first.r);
                const second = grid.getCell(first.q + offset.q, first.r + offset.r);
                if (!second) throw new Error(`missing neighbor: ${orientation} ${stagger} edge ${edge}`);
                for (const cell of [first, second]) {
                    cell.imageId = 'image';
                    cell.cropRegion = { x: 0, y: 0, w: 50, h: 50 };
                }
                const group = { id: 'panel', cells: [first, second].map(({ q, r }) => ({ q, r })) };
                const geometry = getPanelGeometry(group, grid, 0);
                const [a, b] = geometry.cells.map(member => member.vertices);
                let shared;
                const near = (x, y) => Math.hypot(x.x - y.x, x.y - y.y) < 1e-6;
                for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
                    if (near(a[i], b[(j + 1) % b.length]) && near(a[(i + 1) % a.length], b[j])) shared = [a[i], a[(i + 1) % a.length]];
                }
                if (!shared) throw new Error(`missing shared edge: ${orientation} ${stagger} ${edge}`);
                const canvas = renderPanelCanvas(group, grid, processor, 0);
                const context = canvas.getContext('2d');
                for (const t of [0.25, 0.4, 0.5, 0.6, 0.75]) {
                    const x = shared[0].x * (1 - t) + shared[1].x * t;
                    const y = shared[0].y * (1 - t) + shared[1].y * t;
                    const px = Math.floor((x - geometry.bbox.minX) * canvas.width / geometry.bbox.width);
                    const py = Math.floor((y - geometry.bbox.minY) * canvas.height / geometry.bbox.height);
                    const alpha = context.getImageData(px, py, 1, 1).data[3];
                    checked++;
                    if (alpha < 250) failures.push({ orientation, stagger, edge, t, alpha });
                }
            }
        }
        return { checked, failures };
    });
    assert.equal(failures.checked, 120);
    assert.deepEqual(failures.failures, [], 'a shared edge should not create a transparent seam');
});

test('panel keeps planned half-hex clipping and maps a rotated source into the original crop', async () => {
    const result = await page.evaluate(async () => {
        const { default: GridManager } = await import('/js/grid-manager.js');
        const { default: ImageProcessor } = await import('/js/image-processor.js');
        const { getPanelGeometry, renderPanelCanvas } = await import('/js/panel-export.js');
        const grid = new GridManager();
        grid.updateConfig({ columns: 2, rows: 2, hexSize: 20, dpi: 300, orientation: 'flat-top', stagger: 'left', gap: 3, halfHexes: true });
        const source = document.createElement('canvas');
        source.width = 80; source.height = 40;
        const sourceCtx = source.getContext('2d');
        sourceCtx.fillStyle = '#f00'; sourceCtx.fillRect(0, 0, 40, 40);
        sourceCtx.fillStyle = '#00f'; sourceCtx.fillRect(40, 0, 40, 40);
        const processor = new ImageProcessor();
        processor.images.set('fixture', { id: 'fixture', imgElement: source, width: 80, height: 40 });
        processor.rotateImage('fixture', 90);
        const first = grid.getAllCells().find(cell => cell.col === 0 && cell.row === 0);
        const second = grid.getAllCells().find(cell => cell.col === 0 && cell.row === 1);
        for (const cell of [first, second]) {
            cell.imageId = 'fixture';
            cell.cropRegion = { x: 0, y: 0, w: 40, h: 80 };
        }
        const group = { id: 'panel', cells: [first, second].map(({ q, r }) => ({ q, r })) };
        const geometry = getPanelGeometry(group, grid, 0);
        const panel = renderPanelCanvas(group, grid, processor, 0);
        const panelCtx = panel.getContext('2d');
        const samples = [];
        for (const item of geometry.cells) {
            const tile = processor.createHexagonCanvas(item.cell, grid);
            const tileCtx = tile.getContext('2d');
            const minX = Math.min(...item.vertices.map(vertex => vertex.x));
            const maxX = Math.max(...item.vertices.map(vertex => vertex.x));
            const minY = Math.min(...item.vertices.map(vertex => vertex.y));
            const maxY = Math.max(...item.vertices.map(vertex => vertex.y));
            for (const [fx, fy] of [[0.4, 0.3], [0.6, 0.7]]) {
                const x = minX + (maxX - minX) * fx;
                const y = minY + (maxY - minY) * fy;
                const px = Math.floor((x - geometry.bbox.minX) * panel.width / geometry.bbox.width);
                const py = Math.floor((y - geometry.bbox.minY) * panel.height / geometry.bbox.height);
                const tileX = Math.floor(fx * tile.width), tileY = Math.floor(fy * tile.height);
                const expected = [...tileCtx.getImageData(tileX, tileY, 1, 1).data];
                const actual = [...panelCtx.getImageData(px, py, 1, 1).data];
                if (expected[3] === 255) samples.push({ expected, actual });
            }
        }
        return { samples, vertices: geometry.cells.map(item => item.vertices.length), rotated: [processor.getImage('fixture').rotatedCanvas.width, processor.getImage('fixture').rotatedCanvas.height] };
    });
    assert.deepEqual(result.rotated, [40, 80]);
    assert.ok(result.vertices.some(count => count !== 6), 'fixture must contain a clipped hexagon');
    assert.ok(result.samples.length >= 2, 'sample fully covered pixels of the clipped cells');
    for (const { expected, actual } of result.samples) {
        assert.ok(actual[3] >= 250 && expected.slice(0, 3).every((value, channel) => Math.abs(value - actual[channel]) <= 3),
            `rotated crop differs between the planned hex and panel: ${JSON.stringify({ expected, actual })}`);
    }
});

test('keyboard selection and Escape in group mode do not toggle hexes', async () => {
    await page.locator('#btn-mode-groups').click();
    await page.locator('#planner-canvas').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => ({
        selected: window.panelController.selected.size,
        enabled: window.gridManager.getAllCells().filter(cell => !cell.enabled).length
    })), { selected: 2, enabled: 0 });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.panelController.selected.size), 0);
    assert.ok(await page.evaluate(() => window.gridManager.getAllCells().every(cell => cell.enabled)));
});

test('mobile taps select group members without toggling and the page fits the viewport', async () => {
    await context.close();
    context = await browser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true
    });
    page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ready();
    await page.locator('#btn-mode-groups').click();
    const points = await page.evaluate(async () => {
        const { default: HexMath } = await import('/js/hex-math.js');
        const config = window.gridManager.config;
        return ['A1', 'A2'].map(label => {
            const cell = window.gridManager.getAllCells().find(item => item.label === label);
            const center = HexMath.axialToPixel(cell.q, cell.r, config.hexSize, config.orientation, config.gap, config.stagger);
            return window.planner.worldToScreen(center.x, center.y);
        });
    });
    const bounds = await page.locator('#planner-canvas').boundingBox();
    for (const point of points) await page.touchscreen.tap(bounds.x + point.x, bounds.y + point.y);
    const state = await page.evaluate(() => ({
        selected: window.panelController.selected.size,
        disabled: window.gridManager.getAllCells().filter(cell => !cell.enabled).length,
        viewportWidth: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth
    }));
    assert.equal(state.selected, 2);
    assert.equal(state.disabled, 0);
    assert.ok(state.pageWidth <= state.viewportWidth, `horizontal overflow: ${JSON.stringify(state)}`);
});

test('a crop extending outside its source preserves transparent image margins', async () => {
    const samples = await page.evaluate(async () => {
        const { default: GridManager } = await import('/js/grid-manager.js');
        const { getPanelGeometry, renderPanelCanvas } = await import('/js/panel-export.js');
        const grid = new GridManager();
        grid.updateConfig({ columns: 1, rows: 2, hexSize: 20, dpi: 150, gap: 2, orientation: 'flat-top' });
        const members = grid.getAllCells();
        const source = document.createElement('canvas');
        source.width = source.height = 20;
        const sourceCtx = source.getContext('2d');
        sourceCtx.fillStyle = 'red'; sourceCtx.fillRect(0, 0, 20, 20);
        for (const cell of members) {
            cell.imageId = 'image';
            cell.cropRegion = { x: -10, y: 0, w: 40, h: 20 };
        }
        const processor = { getImage: () => ({ imgElement: source }), getRotatedCanvasOrImage: image => image.imgElement };
        const group = { id: 'panel', cells: members.map(({ q, r }) => ({ q, r })) };
        const geometry = getPanelGeometry(group, grid, 0);
        const canvas = renderPanelCanvas(group, grid, processor, 0);
        const ctx = canvas.getContext('2d');
        const center = geometry.cells[0].center;
        const sample = x => {
            const px = Math.floor((center.x + x - geometry.bbox.minX) * canvas.width / geometry.bbox.width);
            const py = Math.floor((center.y - geometry.bbox.minY) * canvas.height / geometry.bbox.height);
            return [...ctx.getImageData(px, py, 1, 1).data];
        };
        return { left: sample(-15), middle: sample(0), right: sample(15) };
    });
    assert.equal(samples.left[3], 0);
    assert.ok(samples.middle[0] > 240 && samples.middle[3] === 255);
    assert.equal(samples.right[3], 0);
});
