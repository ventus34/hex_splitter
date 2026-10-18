import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { createProjectArchiveEntries } from '../js/project-archive.js';
import ZipWriter from '../js/zip-writer.js';

const layout = { grid: { columns: 1, rows: 1, hexSize: 100, gap: 0 }, cells: [] };
function image() {
    return { id: 'fixture', name: 'image.svg', width: 40, height: 20, rotation: 90, zoom: 1.5,
        blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"></svg>'], { type: 'image/svg+xml' }) };
}

test('project archive preserves source Blob and metadata in an import-compatible ZIP', async () => {
    const source = image();
    const entries = await createProjectArchiveEntries([source], { ...layout, activeImageId: source.id });
    assert.equal(entries[1].blob, source.blob);
    const chunks = [];
    const writer = new ZipWriter({ write: async bytes => chunks.push(bytes.slice()), close: async () => {}, abort: async () => {} });
    for (const entry of entries) await writer.add(entry.name, entry.blob);
    await writer.close();
    const archive = await JSZip.loadAsync(await new Blob(chunks).arrayBuffer(), { checkCRC32: true });
    const manifest = JSON.parse(await archive.file('project.json').async('text'));
    assert.equal(manifest.images[0].rotation, 90);
    assert.equal(manifest.images[0].mimeType, 'image/svg+xml');
    assert.equal(await archive.file('images/fixture').async('text'), await source.blob.text());
});

test('project save refuses missing references and invalid source metadata before writing', async () => {
    await assert.rejects(createProjectArchiveEntries([], { ...layout, activeImageId: 'missing' }), /Aktywny obraz/);
    await assert.rejects(createProjectArchiveEntries([{ ...image(), id: '../escape' }], layout), /niebezpieczną ścieżkę/);
    await assert.rejects(createProjectArchiveEntries([{ ...image(), blob: null }], layout), /Brakuje danych/);
});

test('an empty project still produces a manifest, and cancelled capture produces no entries', async () => {
    assert.equal((await createProjectArchiveEntries([], layout)).length, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createProjectArchiveEntries([], layout, { signal: controller.signal }), { name: 'AbortError' });
});
