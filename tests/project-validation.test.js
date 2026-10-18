import assert from 'node:assert/strict';
import {
    parseBoundedNumber,
    inferImageMimeType,
    normalizeProjectImageBlob,
    validateProjectArchiveMetadata,
    validateProjectLayout
} from '../js/project-validation.js';

const projectLayout = () => ({
    grid: { columns: 2, rows: 1, hexSize: 100, gap: 0, orientation: 'flat-top', stagger: 'left' },
    imageMode: 'multi',
    activeImageId: 'img_a',
    cells: [{ q: 0, r: 0, enabled: true, imageId: 'img_a', cropRegion: { x: 0, y: 0, w: 100, h: 100 } }]
});

function makeZip(entries) {
    const files = Object.fromEntries(Object.entries(entries).map(([name, size]) => [name, {
        name,
        dir: false,
        _data: { uncompressedSize: size }
    }]));
    return { files, file: name => files[name] || null };
}

function makeLegacyProject() {
    const image = {
        id: 'img_a', name: 'sample.png', width: 100, height: 100,
        filename: 'images/img_a'
    };
    return {
        project: { layout: projectLayout(), images: [image] },
        zip: makeZip({ 'project.json': 2048, 'images/img_a': 512 })
    };
}

assert.equal(parseBoundedNumber('0', 2, 0, 50), 0);
assert.equal(parseBoundedNumber('', 2, 0, 50), 2);
assert.equal(parseBoundedNumber(null, 2, 0, 50), 2);
assert.equal(parseBoundedNumber('100', 2, 0, 25), 25);
assert.equal(parseBoundedNumber('invalid', 2, 0, 25), 2);
assert.equal(await inferImageMimeType(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>']), 'unnamed'), 'image/svg+xml');
assert.equal((await normalizeProjectImageBlob(new Blob(['<svg/>']), undefined, 'drawing.svg')).type, 'image/svg+xml');

const legacy = makeLegacyProject();
assert.equal(validateProjectArchiveMetadata(legacy.project, legacy.zip).length, 1,
    'legacy projects without schemaVersion remain supported');
assert.equal(validateProjectLayout(legacy.project.layout).grid.gap, 0,
    'zero-valued gap remains valid');

const missingAsset = makeLegacyProject();
missingAsset.zip = makeZip({ 'project.json': 2048 });
assert.throws(() => validateProjectArchiveMetadata(missingAsset.project, missingAsset.zip), /Brakuje pliku obrazu/);

const badGrid = makeLegacyProject();
badGrid.project.layout.grid.columns = 26;
assert.throws(() => validateProjectArchiveMetadata(badGrid.project, badGrid.zip), /columns/);

const pathTraversal = makeLegacyProject();
pathTraversal.zip.files['../secret'] = { name: '../secret', dir: false, _data: { uncompressedSize: 10 } };
assert.throws(() => validateProjectArchiveMetadata(pathTraversal.project, pathTraversal.zip), /niebezpieczną ścieżkę/);

const reservedLayoutId = makeLegacyProject();
reservedLayoutId.project.images[0].id = '__hexsplitter_project_layout__';
reservedLayoutId.project.layout.activeImageId = '__hexsplitter_project_layout__';
reservedLayoutId.project.layout.cells[0].imageId = '__hexsplitter_project_layout__';
assert.throws(() => validateProjectArchiveMetadata(reservedLayoutId.project, reservedLayoutId.zip), /Identyfikator obrazu/);

const oversizedEntry = makeLegacyProject();
oversizedEntry.zip.files['images/img_a']._data.uncompressedSize = 60 * 1024 * 1024;
assert.throws(() => validateProjectArchiveMetadata(oversizedEntry.project, oversizedEntry.zip), /zbyt duży/);

console.log('Project validation tests passed.');
