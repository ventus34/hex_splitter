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

test('planner keyboard arrows select cells and Space toggles the selected cell', async t => {
    const page = await openPage(t);
    const canvas = page.locator('#planner-canvas');
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');

    await page.waitForFunction(() => {
        const cell = window.gridManager.getAllCells().find(item => item.col === 1 && item.row === 0);
        return cell && !cell.enabled;
    });
    assert.equal(await page.locator('#planner-live-status').textContent(), 'B1: inactive');
});

test('touch tap toggles a cell and the mobile canvas stays within the viewport', async t => {
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
    await page.waitForFunction(() => {
        const cell = window.gridManager.getAllCells().find(item => item.col === 0 && item.row === 0);
        return cell && !cell.enabled;
    });
});

test('AMS reuses an unchanged raster and invalidates it when cells or crops change', async t => {
    const page = await openPage(t);
    await showPreview(page);

    const result = await page.evaluate(() => {
        const preview = window.preview;
        preview.options = {
            ...preview.options,
            amsPreview: true,
            amsColors: 4,
            showFrames: false,
            showLabels: false,
            showRuler: false,
            showHangers: false
        };
        // Keep this cache assertion synchronous; worker scheduling has focused
        // coverage in tests/ams-worker.test.mjs.
        preview.amsWorkerEnabled = false;

        const quantize = preview.quantizeColors.bind(preview);
        preview.__quantizeCount = 0;
        preview.quantizeColors = (...args) => {
            preview.__quantizeCount++;
            return quantize(...args);
        };

        preview.render();
        const initialKey = preview.amsCacheKey;
        preview.render();
        const afterRepeat = preview.__quantizeCount;

        const cell = window.gridManager.getAllCells()[0];
        cell.enabled = false;
        preview.render();
        const afterActiveChange = preview.__quantizeCount;
        const activeKey = preview.amsCacheKey;

        const source = document.createElement('canvas');
        source.width = 40;
        source.height = 20;
        const sourceCtx = source.getContext('2d');
        sourceCtx.fillStyle = '#e22';
        sourceCtx.fillRect(0, 0, 40, 20);
        const id = 'render-cache-fixture';
        window.imageProcessor.images.set(id, {
            id,
            name: 'render-cache-fixture',
            imgElement: source,
            width: source.width,
            height: source.height,
            rotatedCanvas: null
        });
        cell.enabled = true;
        cell.imageId = id;
        cell.cropRegion = { x: 0, y: 0, w: 20, h: 10 };
        preview.render();
        const afterImageAssignment = preview.__quantizeCount;
        const imageKey = preview.amsCacheKey;

        cell.cropRegion = { ...cell.cropRegion, x: 1 };
        preview.render();
        const afterCropChange = preview.__quantizeCount;
        const cropKey = preview.amsCacheKey;

        return {
            afterRepeat,
            afterActiveChange,
            afterImageAssignment,
            afterCropChange,
            activeKeyChanged: activeKey !== initialKey,
            imageKeyChanged: imageKey !== activeKey,
            cropKeyChanged: cropKey !== imageKey
        };
    });

    assert.equal(result.afterRepeat, 1, 'unchanged preview should reuse the cached AMS raster');
    assert.equal(result.afterActiveChange, 2, 'changing active cells should requantize');
    assert.equal(result.afterImageAssignment, 3, 'assigning a new source image should requantize');
    assert.equal(result.afterCropChange, 4, 'changing the crop should requantize');
    assert.equal(result.activeKeyChanged, true);
    assert.equal(result.imageKeyChanged, true);
    assert.equal(result.cropKeyChanged, true);
});

test('preview rendering preserves zero frame clearance and clamps other values to UI limits', async t => {
    const page = await openPage(t);
    await showPreview(page);
    const values = await page.evaluate(() => {
        const preview = window.preview;
        preview.options = { ...preview.options, amsPreview: false, showFrames: true, showLabels: false, showRuler: false };
        document.getElementById('frame-width').value = '0';
        document.getElementById('frame-clearance').value = '0';
        let observed = null;
        preview.drawFrame = (...args) => { observed = { width: args[6], clearance: args[7] }; };
        preview.render();
        document.getElementById('hanger-clearance').value = '0';
        document.getElementById('hanger-arm-width').value = '0';
        return {
            frame: observed,
            hangerClearance: preview.readNumberInput('hanger-clearance', 0.3),
            hangerArmWidth: preview.readNumberInput('hanger-arm-width', 12)
        };
    });
    assert.deepEqual(values.frame, { width: 1, clearance: 0 });
    assert.equal(values.hangerClearance, 0);
    assert.equal(values.hangerArmWidth, 5);
});
