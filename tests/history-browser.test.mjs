import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createStaticServer } from '../server/static-server.js';
import { waitForAsyncPageCondition } from './helpers/poll.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#e22"/></svg>'
);

let server;
let browser;
let baseUrl;
let context;
let page;

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

beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
        window.gridManager && window.imageProcessor && window.gridManager.getAllCells().length > 0
    ));
    await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
});

afterEach(async () => {
    await context?.close();
    context = undefined;
});

async function setNumber(selector, value) {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).dispatchEvent('input');
}

async function uploadImage(name = 'history-fixture.svg') {
    await page.locator('#file-input').setInputFiles({ name, mimeType: 'image/svg+xml', buffer: svg });
    await page.waitForFunction(() => document.querySelectorAll('.image-item').length > 0);
    await page.waitForFunction(() => window.imageProcessor?.getAllImages().length > 0);
}

async function imageRecords() {
    return page.evaluate(async () => {
        const { default: ProjectStore } = await import('/js/project-store.js');
        return (await ProjectStore.getAll()).map(({ id, name, rotation, zoom }) => ({ id, name, rotation, zoom }));
    });
}

async function waitForImageTransforms(rotation, zoom) {
    await page.waitForFunction(({ rotation: expectedRotation, zoom: expectedZoom }) => {
        const image = window.imageProcessor?.getAllImages()?.[0];
        return image && (image.rotation ?? 0) === expectedRotation && (image.zoom ?? 1) === expectedZoom;
    }, { rotation, zoom });
    await waitForAsyncPageCondition(page, async ({ rotation: expectedRotation, zoom: expectedZoom }) => {
        const { default: ProjectStore } = await import('/js/project-store.js');
        const image = (await ProjectStore.getAll())[0];
        return image && image.rotation === expectedRotation && image.zoom === expectedZoom;
    }, { rotation, zoom });
}

async function gridState() {
    return page.evaluate(() => ({
        columns: window.gridManager.config.columns,
        rows: window.gridManager.config.rows,
        cells: window.gridManager.getAllCells().map(({ q, r, enabled }) => ({ q, r, enabled }))
    }));
}

async function setHistoryButtonsState(canUndo, canRedo) {
    await page.waitForFunction(({ canUndo: expectedUndo, canRedo: expectedRedo }) => {
        const undo = document.getElementById('btn-undo');
        const redo = document.getElementById('btn-redo');
        return undo && redo && undo.disabled === !expectedUndo && redo.disabled === !expectedRedo;
    }, { canUndo, canRedo });
}

test('grid dimension undo and redo restores dimensions and the cell enabled mask', async () => {
    const initial = await gridState();
    assert.equal(initial.columns, 4);
    assert.equal(initial.rows, 3);
    assert.ok(initial.cells.every(cell => cell.enabled));

    await setNumber('#grid-cols', 2);
    await page.waitForFunction(() => window.gridManager.config.columns === 2);
    await page.locator('#planner-canvas').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === false);
    await setNumber('#grid-rows', 2);
    await page.waitForFunction(() => window.gridManager.config.rows === 2);

    const edited = await gridState();
    assert.equal(edited.columns, 2);
    assert.equal(edited.rows, 2);
    assert.equal(edited.cells.length, 4);
    assert.equal(edited.cells[0].enabled, false);

    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.config.rows === 3);
    assert.equal((await gridState()).cells[0].enabled, false);

    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === true);
    assert.equal((await gridState()).columns, 2);

    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.config.columns === 4);
    assert.ok((await gridState()).cells.every(cell => cell.enabled));

    await page.locator('#btn-redo').click();
    await page.waitForFunction(() => window.gridManager.config.columns === 2);
    await page.locator('#btn-redo').click();
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === false);
    await page.locator('#btn-redo').click();
    await page.waitForFunction(() => window.gridManager.config.rows === 2);
    assert.equal((await gridState()).cells[0].enabled, false);
});

test('canvas keyboard toggle is undoable, and shortcuts stay out of text fields', async () => {
    const canvas = page.locator('#planner-canvas');
    await canvas.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === false);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === true);
    await page.keyboard.press('Control+y');
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === false);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === true);
    await page.keyboard.press('Meta+Shift+z');
    await page.waitForFunction(() => window.gridManager.getAllCells()[0]?.enabled === false);

    await setNumber('#grid-cols', 2);
    await page.waitForFunction(() => window.gridManager.config.columns === 2);
    await setHistoryButtonsState(true, false);
    await page.locator('#grid-rows').focus();
    await page.keyboard.press('Control+z');
    assert.equal((await gridState()).columns, 2, 'Ctrl+Z in a numeric input must not undo the project');

    await page.locator('#btn-undo').click();
    await page.waitForFunction(() => window.gridManager.config.columns === 4);
    await setHistoryButtonsState(true, true);
    await page.locator('#btn-redo').click();
    await page.waitForFunction(() => window.gridManager.config.columns === 2);
});

test('rotation and zoom undo as separate edits and restore IndexedDB values', async () => {
    await uploadImage();
    await setHistoryButtonsState(false, false);

    await setNumber('.rotation-number-input', 90);
    await waitForImageTransforms(90, 1);
    await setHistoryButtonsState(true, false);

    await setNumber('.zoom-number-input', 200);
    await waitForImageTransforms(90, 2);
    await page.locator('#btn-undo').click();
    await waitForImageTransforms(90, 1);

    await page.locator('#btn-undo').click();
    await waitForImageTransforms(0, 1);
    assert.equal((await imageRecords()).length, 1);

    await page.locator('#btn-redo').click();
    await waitForImageTransforms(90, 1);
    await page.keyboard.press('Control+Shift+z');
    await waitForImageTransforms(90, 2);
    assert.deepEqual(
        (({ rotation, zoom }) => ({ rotation, zoom }))((await imageRecords())[0]),
        { rotation: 90, zoom: 2 }
    );
});

test('adding or removing library images resets history without resurrecting deleted assets', async () => {
    await setNumber('#grid-cols', 2);
    await page.waitForFunction(() => window.gridManager.config.columns === 2);
    await setHistoryButtonsState(true, false);

    await uploadImage('first.svg');
    await setHistoryButtonsState(false, false);
    await setNumber('#grid-rows', 2);
    await page.waitForFunction(() => window.gridManager.config.rows === 2);
    await setHistoryButtonsState(true, false);

    await uploadImage('second.svg');
    await page.waitForFunction(() => document.querySelectorAll('.image-item').length === 2);
    await setHistoryButtonsState(false, false);

    await page.locator('.image-item').last().locator('.btn-remove-image').click();
    await page.waitForFunction(() => document.querySelectorAll('.image-item').length === 1);
    await setHistoryButtonsState(false, false);
    await page.keyboard.press('Control+z');

    assert.equal(await page.locator('.image-item').count(), 1);
    assert.equal((await imageRecords()).length, 1);
    assert.equal((await gridState()).rows, 2);
});

test('a continuous image positioning drag is a single undo and redo step', async () => {
    await uploadImage();
    await page.locator('#btn-mode-image').click();
    const canvas = page.locator('#planner-canvas');
    const box = await canvas.boundingBox();
    assert.ok(box);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    const originalOffset = await page.evaluate(() => window.gridManager.config.singleImageOffsetX || 0);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 20, startY + 5, { steps: 2 });
    await page.mouse.move(startX + 45, startY + 10, { steps: 3 });
    await page.mouse.up();

    await page.waitForFunction(value => (window.gridManager.config.singleImageOffsetX || 0) !== value, originalOffset);
    const finalOffset = await page.evaluate(() => window.gridManager.config.singleImageOffsetX || 0);
    assert.ok(finalOffset > originalOffset);

    await page.locator('#btn-undo').click();
    await page.waitForFunction(value => (window.gridManager.config.singleImageOffsetX || 0) === value, originalOffset);
    await page.locator('#btn-redo').click();
    await page.waitForFunction(value => (window.gridManager.config.singleImageOffsetX || 0) === value, finalOffset);
});

test('clearing an empty project starts a fresh history', async () => {
    await setNumber('#grid-cols', 2);
    await setHistoryButtonsState(true, false);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#btn-reset-project').click();
    await page.waitForFunction(() => window.gridManager.config.columns === 4);
    await setHistoryButtonsState(false, false);
});
