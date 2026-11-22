import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import HexMath from '../js/hex-math.js';
import { createStaticServer } from '../server/static-server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server;
let browser;
let baseUrl;

before(async () => {
    server = createStaticServer({ root: repoRoot });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const launchOptions = { headless: true };
    if (process.env.CHROME_CHANNEL) launchOptions.channel = process.env.CHROME_CHANNEL;
    browser = await chromium.launch(launchOptions);
});

after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
});

async function openPage(t, contextOptions = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOptions });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
        window.gridManager && window.planner && window.preview && window.gridManager.getAllCells().length
    ));
    await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
    return page;
}

async function showPreview(page) {
    await page.locator('.tab-btn[data-tab="tab-preview"]').click();
    await page.waitForFunction(() => document.querySelector('#preview-canvas')?.width > 0);
    await page.waitForFunction(() => window.preview?.renderRequested === false);
}

test('planner keyboard arrows select cells and Space opens their controls', async t => {
    const page = await openPage(t);
    const canvas = page.locator('#planner-canvas');
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');

    assert.equal(await page.locator('#hex-editor-title').textContent(), 'Hex B1');
    assert.equal(await page.evaluate(() => window.gridManager.cells.size), 12);
});

test('touch tap selects a cell and the mobile canvas stays within the viewport', async t => {
    const page = await openPage(t, {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
    });
    const cellInfo = await page.evaluate(() => {
        const cell = window.gridManager.getAllCells().find(item => item.col === 0 && item.row === 0);
        return { q: cell.q, r: cell.r, config: { ...window.gridManager.config } };
    });
    const centerMm = HexMath.axialToPixel(
        cellInfo.q,
        cellInfo.r,
        cellInfo.config.hexSize,
        cellInfo.config.orientation,
        cellInfo.config.gap,
        cellInfo.config.stagger
    );
    const centerScreen = await page.evaluate(point => window.planner.worldToScreen(point.x, point.y), centerMm);
    const canvasBounds = await page.locator('#planner-canvas').boundingBox();
    assert.ok(canvasBounds && canvasBounds.width > 0 && canvasBounds.height > 0);

    const layout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        canvas: document.querySelector('#planner-canvas').getBoundingClientRect().toJSON()
    }));
    assert.ok(layout.documentWidth <= layout.viewportWidth, `mobile page overflows horizontally: ${JSON.stringify(layout)}`);
    assert.ok(layout.canvas.width > 0 && layout.canvas.right <= layout.viewportWidth + 1);

    await page.touchscreen.tap(canvasBounds.x + centerScreen.x, canvasBounds.y + centerScreen.y);
    assert.equal(await page.locator('#hex-editor-title').textContent(), 'Hex A1');
    assert.equal(await page.evaluate(() => window.gridManager.cells.size), 12);
});

test('preview rendering preserves zero frame clearance and clamps other values to UI limits', async t => {
    const page = await openPage(t);
    await showPreview(page);
    const values = await page.evaluate(() => {
        const preview = window.preview;
        preview.options = { ...preview.options, showFrames: true, showLabels: false, showRuler: false };
        document.getElementById('frame-width').value = '0';
        document.getElementById('frame-clearance').value = '0';
        let observed = null;
        preview.drawFrame = (...args) => { observed = { width: args[4], clearance: args[5] }; };
        preview.render();
        return observed;
    });
    assert.deepEqual(values, { width: 1, clearance: 0 });
});

test('preview with gaps hidden draws a cut tile and its image at the same position', async t => {
    const page = await openPage(t);
    await showPreview(page);
    const result = await page.evaluate(async () => {
        const { default: HexMath } = await import('/js/hex-math.js');
        const { gridManager: grid, imageProcessor, preview } = window;
        grid.updateConfig({ gap: 50 });
        const target = grid.getAllCells().find(cell => cell.label === 'D2');
        grid.setCellShape(target, { kind: 'cuts', depths: [50, 0, 0, 0, 0, 0] });
        const source = document.createElement('canvas');
        source.width = source.height = 40;
        const ctx = source.getContext('2d');
        ctx.fillStyle = '#f72918';
        ctx.fillRect(0, 0, 40, 40);
        imageProcessor.images.set('preview-fixture', { imgElement: source, width: 40, height: 40 });
        target.imageId = 'preview-fixture';
        Object.assign(preview.options, { showGaps: false, showFrames: false, showLabels: false, showRuler: false });
        preview.centerGrid();
        preview.render();

        const shift = HexMath.getGapTranslation(target, grid.config, 0);
        const polygon = grid.getCellVertices(target);
        const center = polygon.reduce((point, vertex) => ({
            x: point.x + vertex.x / polygon.length, y: point.y + vertex.y / polygon.length
        }), shift);
        const { x, y } = preview.worldToScreen(center.x, center.y);
        return [...preview.ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    });
    assert.deepEqual(result, [247, 41, 24, 255]);
});
