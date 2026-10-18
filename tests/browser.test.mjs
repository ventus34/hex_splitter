import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { createStaticServer } from '../server/static-server.js';
import { waitForAsyncPageCondition } from './helpers/poll.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testImage = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#e22"/><circle cx="8" cy="10" r="5" fill="#22e"/></svg>'
);

let server;
let browser;
let baseUrl;
let context;
let page;
let dialogs = [];
let pageErrors = [];
let consoleErrors = [];

before(async () => {
  server = createStaticServer({ root: repoRoot });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  const launchOptions = { headless: true };
  if (process.env.CHROME_CHANNEL) launchOptions.channel = process.env.CHROME_CHANNEL;
  browser = await chromium.launch(launchOptions);
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
});

beforeEach(async () => {
  dialogs = [];
  pageErrors = [];
  consoleErrors = [];
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.gridManager && window.imageProcessor && window.gridManager.getAllCells().length > 0));
  await page.waitForFunction(() => window.canEditProject?.());
  await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
});

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function uploadImage(name = 'fixture.svg', bytes = testImage) {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'image/svg+xml',
    buffer: bytes
  });
  await page.locator('.image-item').first().waitFor();
  await page.waitForFunction(() => window.imageProcessor.getAllImages().length > 0);
}

async function setNumber(selector, value) {
  await page.locator(selector).fill(String(value));
  await page.locator(selector).dispatchEvent('input');
}

async function captureDownloads() {
  await page.evaluate(() => {
    window.__downloads = [];
    window.saveAs = (blob, filename) => window.__downloads.push({ blob, filename });
  });
}

async function downloadBytes(buttonSelector, index = 0) {
  await page.locator(buttonSelector).click();
  await page.waitForFunction(i => window.__downloads?.length > i, index);
  return page.evaluate(async i => {
    const download = window.__downloads[i];
    return {
      filename: download.filename,
      bytes: Array.from(new Uint8Array(await download.blob.arrayBuffer()))
    };
  }, index).then(result => ({ filename: result.filename, bytes: Buffer.from(result.bytes) }));
}

async function readZip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  return zip;
}

async function importProject(name, bytes) {
  await page.locator('#project-file-input').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: bytes
  });
}

test('project save, browser reload, and import preserve image rotation', async () => {
  await uploadImage();
  await setNumber('.rotation-number-input', 90);
  await page.waitForFunction(() => window.imageProcessor.getAllImages()[0]?.rotation === 90);
  await captureDownloads();

  const saved = await downloadBytes('#btn-save-project');
  assert.equal(saved.filename, 'project.hexproj');
  const archive = await readZip(saved.bytes);
  const manifest = JSON.parse(await archive.file('project.json').async('text'));
  assert.equal(manifest.images[0].rotation, 90);
  assert.equal(manifest.images[0].mimeType, 'image/svg+xml');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.imageProcessor?.getAllImages().length === 1);
  await assert.doesNotReject(page.locator('.rotation-number-input').waitFor());
  assert.equal(await page.locator('.rotation-number-input').inputValue(), '90');
  assert.equal(await page.locator('.image-resolution').textContent(), '20x40 px');

  await setNumber('.rotation-number-input', 0);
  await page.waitForFunction(() => window.imageProcessor.getAllImages()[0]?.rotation === 0);
  await importProject('saved.hexproj', saved.bytes);
  await page.waitForFunction(() => window.imageProcessor?.getAllImages().length === 1 && window.imageProcessor.getAllImages()[0]?.rotation === 90, undefined, { timeout: 8000 }).catch(async error => {
    const state = await page.evaluate(() => ({
      url: location.href,
      images: window.imageProcessor?.getAllImages().map(image => ({ name: image.name, rotation: image.rotation, width: image.width, height: image.height })),
      stored: null,
      layout: JSON.parse(localStorage.getItem('hexsplitter_project_layout') || 'null')
    })).catch(() => null);
    throw new Error(`${error.message}; url=${page.url()}; dialogs=${JSON.stringify(dialogs)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}; state=${JSON.stringify(state)}`);
  });
  assert.equal(await page.locator('.rotation-number-input').inputValue(), '90');
  assert.equal(await page.locator('.image-resolution').textContent(), '20x40 px');
});

test('valid zero settings survive state save and reload', async () => {
  await setNumber('#hex-gap', 0);
  await setNumber('#relief-blur', 0);
  await page.waitForFunction(() => window.gridManager.config.gap === 0);
  assert.equal(await page.locator('#relief-blur').inputValue(), '0');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gridManager?.config.gap === 0);
  assert.equal(await page.locator('#hex-gap').inputValue(), '0');
  assert.equal(await page.locator('#relief-blur').inputValue(), '0');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('hexsplitter_project_layout')));
  assert.equal(persisted.grid.gap, 0);
  assert.equal(persisted.relief.blur, 0);
});

test('bad, incomplete, missing-image, and corrupt-image imports preserve current project', async () => {
  await uploadImage('known-image.svg');
  await setNumber('#grid-cols', 2);
  await page.waitForFunction(() => window.gridManager.config.columns === 2);

  const missingProjectZip = await new JSZip().generateAsync({ type: 'nodebuffer' });
  const missingImageZip = new JSZip();
  missingImageZip.file('project.json', JSON.stringify({
    layout: { grid: { columns: 3, rows: 1, hexSize: 100, gap: 1 }, cells: [] },
    images: [{ id: 'missing', name: 'lost.svg', width: 40, height: 20, filename: 'images/lost' }]
  }));
  const corruptImageZip = new JSZip();
  corruptImageZip.file('project.json', JSON.stringify({
    layout: { grid: { columns: 3, rows: 1, hexSize: 100, gap: 1 }, cells: [] },
    images: [{ id: 'corrupt', name: 'broken.svg', width: 40, height: 20, filename: 'images/corrupt' }]
  }));
  corruptImageZip.file('images/corrupt', Buffer.from('not an image'));

  const badImports = [
    ['not-a-zip.hexproj', Buffer.from('this is not a zip archive')],
    ['missing-project.hexproj', missingProjectZip],
    ['missing-image.hexproj', await missingImageZip.generateAsync({ type: 'nodebuffer' })],
    ['corrupt-image.hexproj', await corruptImageZip.generateAsync({ type: 'nodebuffer' })]
  ];

  for (const [name, bytes] of badImports) {
    const dialogPromise = page.waitForEvent('dialog');
    await importProject(name, bytes);
    const dialog = await dialogPromise;
    assert.match(dialog.message(), /project could not be loaded/i);
    await page.waitForFunction(() => document.querySelector('#project-file-input').value === '');
    assert.equal(await page.locator('.image-item').count(), 1, `${name} removed the existing image`);
    assert.equal(await page.evaluate(() => window.imageProcessor.getAllImages().length), 1, `${name} changed in-memory images`);
    assert.equal(await page.evaluate(() => window.gridManager.config.columns), 2, `${name} changed the current grid`);
    const saved = await page.evaluate(async () => {
      const request = indexedDB.open('HexSplitterImagesDB', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const get = tx.objectStore('images').getAll();
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
    });
    assert.equal(saved.filter(record => record.id !== '__hexsplitter_project_layout__').length, 1, `${name} changed persisted images`);
  }
});

test('IndexedDB replacement rolls back when a write cannot be cloned', async () => {
  await uploadImage('kept.svg');
  const result = await page.evaluate(async () => {
    const { default: ProjectStore } = await import('/js/project-store.js');
    const before = (await ProjectStore.getAll()).map(image => image.id);
    let errorName = null;
    try {
      await ProjectStore.transaction('readwrite', store => {
        store.clear();
        store.put({ id: 'bad-record', value: () => 'not cloneable' });
      });
    } catch (error) {
      errorName = error.name;
    }
    return {
      errorName,
      before,
      after: (await ProjectStore.getAll()).map(image => image.id)
    };
  });
  assert.equal(result.errorName, 'DataCloneError');
  assert.equal(result.before.length, 1);
  assert.deepEqual(result.after, result.before);
  assert.equal(await page.locator('.image-item').count(), 1);
});

test('untrusted image filename is rendered as text in the assembly guide', async () => {
  const payload = '"><img id="xss-probe" src="/missing.png" onerror="window.__xssTriggered=true">.svg';
  await uploadImage(payload);
  await page.evaluate(() => { window.__xssTriggered = false; });
  await page.locator('.tab-btn[data-tab="tab-instructions"]').click();
  await page.locator('#instructions-table-body tr').first().waitFor();
  await page.waitForTimeout(100);

  assert.equal(await page.locator('#xss-probe').count(), 0);
  assert.equal(await page.evaluate(() => window.__xssTriggered), false);
  assert.match(await page.locator('#instructions-table-body').textContent(), /<img id="xss-probe"/);
});

test('image, frame, and relief downloads contain the expected archive entries', async () => {
  await uploadImage();
  await setNumber('#grid-cols', 1);
  await setNumber('#grid-rows', 1);
  await page.waitForFunction(() => window.gridManager.getActiveCells().length === 1 && window.gridManager.getActiveCells()[0].imageId);
  await page.locator('#export-dpi').selectOption('original');
  await captureDownloads();

  const imagesDownload = await downloadBytes('#btn-export-hexes');
  const imagesZip = await readZip(imagesDownload.bytes);
  const imageNames = Object.keys(imagesZip.files).filter(name => !imagesZip.files[name].dir);
  assert.ok(imageNames.some(name => /^hex_A1\.png$/i.test(name)), `unexpected image archive: ${imageNames.join(', ')}`);
  const png = await imagesZip.file(imageNames[0]).async('uint8array');
  assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

  const framesDownload = await downloadBytes('#btn-export-frame-stl', 1);
  const framesZip = await readZip(framesDownload.bytes);
  const frameNames = Object.keys(framesZip.files).filter(name => !framesZip.files[name].dir);
  assert.ok(frameNames.some(name => name.toLowerCase().endsWith('.stl')), `frame archive has no STL: ${frameNames.join(', ')}`);

  const reliefDownload = await downloadBytes('#btn-export-3d-hexes-stl', 2);
  const reliefZip = await readZip(reliefDownload.bytes);
  const reliefNames = Object.keys(reliefZip.files).filter(name => !reliefZip.files[name].dir);
  assert.ok(reliefNames.some(name => name.toLowerCase().endsWith('.stl')), `relief archive has no STL: ${reliefNames.join(', ')}`);
  const stl = await reliefZip.file(reliefNames[0]).async('uint8array');
  const stlBytes = Buffer.from(stl);
  const triangleCount = stlBytes.readUInt32LE(80);
  assert.ok(triangleCount > 0);
  assert.equal(stlBytes.length, 84 + triangleCount * 50);
});

test('native download helper delivers the hanger STL file', async () => {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#btn-export-hanger').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'hexsplitter_uchwyt_y.stl');
  const path = await download.path();
  assert.ok(path);
  assert.ok((await stat(path)).size > 0);
  assert.match((await readFile(path, 'utf8')).slice(0, 64), /^solid symmetric_y_hanger/);
});

test('grid inputs respect documented bounds', async () => {
  await setNumber('#grid-cols', 100);
  await setNumber('#grid-rows', -10);
  await setNumber('#hex-size', 900);
  await page.waitForTimeout(50);
  const config = await page.evaluate(() => ({
    columns: window.gridManager.config.columns,
    rows: window.gridManager.config.rows,
    hexSize: window.gridManager.config.hexSize
  }));
  assert.ok(config.columns >= 1 && config.columns <= 25, `columns out of bounds: ${config.columns}`);
  assert.ok(config.rows >= 1 && config.rows <= 25, `rows out of bounds: ${config.rows}`);
  assert.ok(config.hexSize >= 10 && config.hexSize <= 500, `hex size out of bounds: ${config.hexSize}`);
});

test('planner canvas remains visible at a 390px mobile viewport', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.gridManager));
  await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
  const size = await page.locator('#planner-canvas').evaluate(canvas => ({
    bitmapWidth: canvas.width,
    layoutWidth: canvas.getBoundingClientRect().width,
    wrapperWidth: canvas.parentElement.getBoundingClientRect().width
  }));
  assert.ok(size.bitmapWidth > 0 && size.layoutWidth > 0 && size.wrapperWidth > 0, JSON.stringify(size));
});

test('renderers calculate grid bounds a constant number of times as the grid grows', async () => {
  await setNumber('#grid-cols', 25);
  await setNumber('#grid-rows', 25);
  await page.waitForFunction(() => window.gridManager.getAllCells().length === 625);
  const calls = await page.evaluate(() => {
    const grid = window.gridManager;
    const original = grid.getBoundingBoxMm.bind(grid);
    let count = 0;
    grid.getBoundingBoxMm = (...args) => { count++; return original(...args); };
    window.planner.render();
    window.preview.render();
    grid.getBoundingBoxMm = original;
    return count;
  });
  assert.ok(calls <= 20, `rendering 625 cells recalculated bounds ${calls} times`);
});

test('startup skips an undecodable saved image without deleting its original data', async () => {
  await uploadImage('healthy.svg');
  await page.evaluate(async () => {
    const { default: ProjectStore } = await import('/js/project-store.js');
    await ProjectStore.save('broken-fixture', 'broken.png', new Blob(['not an image'], { type: 'image/png' }), 40, 20);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.gridManager?.cells.size === 12 && window.imageProcessor?.images.size === 1);
  const savedIds = await page.evaluate(async () => {
    const { default: ProjectStore } = await import('/js/project-store.js');
    return (await ProjectStore.getAll()).map(image => image.id);
  });
  assert.ok(savedIds.includes('broken-fixture'), 'startup removed original data instead of keeping it for recovery');
  assert.equal(savedIds.length, 2);
  assert.ok(dialogs.some(message => message.includes('original data remain')), 'missing recovery notice');
});

test('an old pending backup cannot replace a newer durable project revision', async () => {
  await setNumber('#grid-cols', 5);
  await waitForAsyncPageCondition(page, async () => {
    const { default: Store } = await import('/js/project-store.js?v=1.0.3');
    return (await Store.getLayout())?.grid.columns === 5;
  });
  await page.evaluate(async () => {
    const { default: Store } = await import('/js/project-store.js?v=1.0.3');
    const persisted = await Store.getLayout();
    localStorage.setItem('hexsplitter_project_layout', JSON.stringify({
      ...persisted, grid: { ...persisted.grid, columns: 2 },
      savedAt: Date.now() + 1000000, backupBaseSavedAt: persisted.savedAt - 1
    }));
    // Simulate a stale backup left behind by a tab that cannot flush on shutdown.
    projectSession.beforeRelease = async () => false;
    projectSession.beforeSuspend = async () => false;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.canEditProject?.() && window.gridManager.config.columns === 5);
  assert.equal(await page.locator('#grid-cols').inputValue(), '5');
});
