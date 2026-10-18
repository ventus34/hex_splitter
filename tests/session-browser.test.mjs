import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { createStaticServer } from '../server/static-server.js';
import { waitForAsyncPageCondition } from './helpers/poll.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#e22"/></svg>');

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

async function openApp(context) {
    const page = await context.newPage();
    await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
    page.__consoleMessages = [];
    page.on('console', message => page.__consoleMessages.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', error => page.__consoleMessages.push(`pageerror: ${error.message}`));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.projectSession && window.gridManager && window.imageProcessor));
    await page.waitForFunction(() => window.projectSession.state === 'owner' || window.projectSession.state === 'readonly');
    await page.waitForFunction(() => document.querySelector('#planner-canvas')?.width > 0);
    return page;
}

test('same-origin tabs fence edits, transfer ownership, and export one current read-only snapshot', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
        const first = await openApp(context);
        await first.waitForFunction(() => window.canEditProject());
        await first.bringToFront();
        assert.equal(await first.locator('#grid-cols').isDisabled(), false);

        await first.locator('#file-input').setInputFiles({ name: 'session.svg', mimeType: 'image/svg+xml', buffer: svg });
        await first.locator('.image-item').waitFor();
        await first.locator('#grid-cols').fill('5');
        await first.locator('#grid-cols').dispatchEvent('input');
        await first.waitForFunction(() => window.gridManager.config.columns === 5);
        await waitForAsyncPageCondition(first, async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            const snapshot = await store.getProjectSnapshot();
            return snapshot.layout?.grid.columns === 5 && snapshot.images.length === 1;
        });
        const firstSnapshot = await first.evaluate(async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            return {
                owner: window.projectSession.state,
                canEdit: window.canEditProject(),
                columns: window.gridManager.config.columns,
                input: document.getElementById('grid-cols').value,
                local: localStorage.getItem('hexsplitter_project_layout'),
                layout: await store.getLayout(),
                stores: performance.getEntriesByType('resource').map(item => item.name).filter(name => name.includes('project-store'))
            };
        });
        assert.equal(firstSnapshot.layout?.grid?.columns, 5, JSON.stringify(firstSnapshot));

        const second = await openApp(context);
        await second.waitForFunction(() => window.projectSession.state === 'readonly');
        await second.waitForFunction(() => window.gridManager.config.columns === 5 && window.imageProcessor.getAllImages().length === 1);
        assert.equal(await second.locator('#project-session-banner').isVisible(), true);
        assert.equal(await second.locator('#grid-cols').isDisabled(), true);
        // A read-only tab must not clean shared recovery data while loading.
        await second.evaluate(() => localStorage.setItem('hexsplitter_project_layout', '{invalid backup'));
        await second.reload({ waitUntil: 'domcontentloaded' });
        await second.waitForFunction(() => window.projectSession?.state === 'readonly' && window.gridManager?.config.columns === 5);
        assert.equal(await second.evaluate(() => localStorage.getItem('hexsplitter_project_layout')), '{invalid backup');
        // Simulate a stale read-only tab. File export should use one current IndexedDB
        // snapshot rather than mixing this old in-memory layout with newer saved images.
        await second.evaluate(() => {
            window.gridManager.config.columns = 2;
            window.imageProcessor.images.clear();
            window.__testDownload = null;
            window.saveAs = (blob, filename) => { window.__testDownload = { blob, filename }; };
        });
        await second.locator('#btn-save-project').click();
        await second.waitForFunction(() => Boolean(window.__testDownload));
        const archiveBytes = await second.evaluate(async () => Array.from(new Uint8Array(await window.__testDownload.blob.arrayBuffer())));
        const manifest = JSON.parse(await (await JSZip.loadAsync(Buffer.from(archiveBytes))).file('project.json').async('text'));
        assert.equal(manifest.layout.grid.columns, 5, JSON.stringify({ firstSnapshot, messages: { first: first.__consoleMessages, second: second.__consoleMessages }, second: await second.evaluate(async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            return {
                url: location.href,
                state: window.projectSession.state,
                canEdit: window.canEditProject(),
                uiColumns: window.gridManager.config.columns,
                savedLayout: await store.getLayout(),
                snapshotLayout: (await store.getProjectSnapshot()).layout
            };
        }) }));
        assert.equal(manifest.images.length, 1);

        await second.bringToFront();
        await second.locator('#btn-take-over-project').click();
        await second.waitForFunction(() => window.projectSession?.state === 'owner' && window.canEditProject());
        await first.waitForFunction(() => window.projectSession?.state === 'readonly' && !window.canEditProject());
        await second.waitForFunction(() => window.gridManager.config.columns === 5 && window.imageProcessor.getAllImages().length === 1);
        assert.equal(await first.locator('#grid-cols').isDisabled(), true);
        assert.equal(await second.locator('#grid-cols').isDisabled(), false);

        await first.bringToFront();
        await first.locator('#btn-take-over-project').click();
        await first.waitForFunction(() => window.projectSession?.state === 'owner' && window.canEditProject());
        await second.waitForFunction(() => window.projectSession?.state === 'readonly' && !window.canEditProject());
        await first.waitForFunction(() => window.gridManager.config.columns === 5 && window.imageProcessor.getAllImages().length === 1);
    } finally {
        await context.close();
    }
});

test('takeover waits for image removal continuation before persisting the layout', async () => {
    const context = await browser.newContext();
    try {
        const first = await openApp(context);
        await first.waitForFunction(() => window.canEditProject());
        first.once('dialog', dialog => dialog.accept());
        await first.locator('#btn-reset-project').click();
        await waitForAsyncPageCondition(first, async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            return (await store.getAll()).length === 0;
        });

        await first.locator('#file-input').setInputFiles({ name: 'takeover.svg', mimeType: 'image/svg+xml', buffer: svg });
        await first.locator('.image-item').waitFor();
        await first.locator('label.radio-card').nth(1).click();
        const imageId = await first.locator('.image-item').first().getAttribute('data-id');
        await first.evaluate(id => {
            const cell = window.gridManager.getAllCells()[0];
            cell.imageId = id;
            cell.cropRegion = { x: 1, y: 1, w: 12, h: 8 };
            document.getElementById('hanger-clearance').dispatchEvent(new Event('input', { bubbles: true }));
        }, imageId);
        await waitForAsyncPageCondition(first, async id => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            const layout = await store.getLayout();
            return layout?.cells?.some(cell => cell.imageId === id);
        }, imageId);

        const second = await openApp(context);
        await second.waitForFunction(() => window.projectSession.state === 'readonly');
        await first.evaluate(async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            const originalDelete = store.delete.bind(store);
            window.__deleteBarrier = new Promise(resolve => { window.__releaseDelete = resolve; });
            window.__deleteCommitted = false;
            store.delete = async id => {
                await originalDelete(id);
                window.__deleteCommitted = true;
                await window.__deleteBarrier;
            };
        });

        await first.locator('.image-item .btn-remove-image').evaluate(button => button.click());
        await first.waitForFunction(() => window.__deleteCommitted);
        const beforeRelease = await first.evaluate(async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            const layout = await store.getLayout();
            return { images: (await store.getAll()).length, imageId: layout?.cells?.[0]?.imageId ?? null };
        });
        assert.deepEqual(beforeRelease, { images: 0, imageId });

        await second.bringToFront();
        await second.locator('#btn-take-over-project').click();
        await first.waitForFunction(() => window.projectSession.state === 'releasing');
        await second.waitForFunction(() => window.projectSession.state === 'taking-over');
        assert.equal(await second.evaluate(() => window.canEditProject()), false, 'takeover completed while an image operation was pending');

        await first.evaluate(() => window.__releaseDelete());
        await second.waitForFunction(() => window.projectSession?.state === 'owner' && window.canEditProject());
        const committed = await second.evaluate(async () => {
            const { default: store } = await import('/js/project-store.js?v=1.0.3');
            const layout = await store.getLayout();
            return { images: (await store.getAll()).length, imageId: layout?.cells?.[0]?.imageId ?? null };
        });
        assert.deepEqual(committed, { images: 0, imageId: null });
    } finally {
        await context.close();
    }
});

test('IndexedDB lease fallback fences stale writes and handles a refused takeover', async () => {
    const context = await browser.newContext();
    try {
        const page = await openApp(context);
        const result = await page.evaluate(async () => {
            const [{ default: Store }, { default: ProjectSession }] = await Promise.all([
                import('/js/project-store.js'), import('/js/project-session.js')
            ]);
            Store.DB_NAME = `HexSplitterSessionFallback_${crypto.randomUUID()}`;
            Store.databasePromise = null;
            Store.writeGuard = null;
            let allowRelease = false;
            const origin = `http://fallback-${crypto.randomUUID()}`;
            const first = new ProjectSession({
                store: Store,
                navigatorRef: {},
                documentRef: null,
                origin,
                beforeRelease: async () => allowRelease
            });
            const second = new ProjectSession({ store: Store, navigatorRef: {}, documentRef: null, origin });
            try {
                await first.start();
                const firstStartedAsOwner = first.isOwner;
                const firstStartedState = first.state;
                const firstStartedOwnsLease = first._ownsLease;
                await second.start();
                const secondStartedReadOnly = second.state === 'readonly';
                Store.setWriteGuard(second);
                let staleWriteRejected = false;
                try { await Store.save('stale', 'stale.svg', new Blob(['x'], { type: 'image/svg+xml' }), 1, 1); }
                catch { staleWriteRejected = true; }
                const refused = await second.takeOver();
                const refusalReturnedReadOnly = second.state === 'readonly';
                const firstKeptOwnership = first.isOwner;
                allowRelease = true;
                const acquired = await second.takeOver();
                Store.setWriteGuard(second);
                await Store.save('fresh', 'fresh.svg', new Blob(['x'], { type: 'image/svg+xml' }), 1, 1);
                return {
                    firstStartedAsOwner,
                    firstStartedState,
                    firstStartedOwnsLease,
                    secondStartedReadOnly,
                    staleWriteRejected,
                    refusalReported: refused === false && refusalReturnedReadOnly,
                    firstKeptOwnership,
                    secondAcquired: acquired && second.isOwner,
                    firstWasFenced: !first.isOwner,
                    savedIds: (await Store.getAll()).map(image => image.id)
                };
            } finally {
                await first.close();
                await second.close();
                Store.close();
            }
        });

        assert.equal(result.firstStartedAsOwner, true, JSON.stringify(result));
        assert.equal(result.secondStartedReadOnly, true);
        assert.equal(result.staleWriteRejected, true);
        assert.equal(result.refusalReported, true);
        assert.equal(result.firstKeptOwnership, true);
        assert.equal(result.secondAcquired, true);
        assert.equal(result.firstWasFenced, true);
        assert.deepEqual(result.savedIds, ['fresh']);
    } finally {
        await context.close();
    }
});
