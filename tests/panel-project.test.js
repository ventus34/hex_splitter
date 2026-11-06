import test from 'node:test';
import assert from 'node:assert/strict';
import GridManager from '../js/grid-manager.js';
import { validateProjectLayout, PROJECT_SCHEMA_VERSION } from '../js/project-validation.js';
import { createProjectArchiveEntries } from '../js/project-archive.js';
import ProjectHistory from '../js/project-history.js';

function fixture() {
    const grid = new GridManager();
    grid.updateConfig({ columns: 2, rows: 2, gap: 2 });
    return {
        grid: { ...grid.config, exportQuality: 90 },
        cells: grid.getAllCells().map(({ q, r, enabled }) => ({ q, r, enabled })),
        panelExport: { gapMm: 0, groups: [{ id: 'panel_test', cells: [{ q: 0, r: 0 }, { q: 0, r: 1 }] }] }
    };
}

test('schema 2 archives preserve independent panel membership and zero gap', async () => {
    const layout = fixture();
    layout.grid.exportQuality = 90;
    layout.cells[0].groupId = 'span_independent';
    const entries = await createProjectArchiveEntries([], layout);
    const manifest = JSON.parse(await entries[0].blob.text());
    assert.equal(PROJECT_SCHEMA_VERSION, 2);
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.layout.panelExport, layout.panelExport);
    assert.equal(manifest.layout.cells[0].groupId, 'span_independent');
    assert.deepEqual(validateProjectLayout(manifest.layout).panelExport, layout.panelExport);
});

test('older layouts default to empty panels and invalid panel imports fail validation', () => {
    const legacy = fixture();
    delete legacy.panelExport;
    assert.deepEqual(validateProjectLayout(legacy).panelExport, { gapMm: 0, groups: [] });
    for (const alter of [
        layout => { layout.panelExport.gapMm = -1; },
        layout => { layout.panelExport.groups[0].cells[1] = { q: 24, r: 24 }; },
        layout => { layout.cells[1].enabled = false; },
        layout => { layout.panelExport.groups.push(structuredClone(layout.panelExport.groups[0])); }
    ]) {
        const layout = fixture();
        alter(layout);
        assert.throws(() => validateProjectLayout(layout), error => error.code?.startsWith('PANEL_'));
    }
});

test('history snapshots isolate panel membership and gap during undo and redo', () => {
    const history = new ProjectHistory();
    const layout = fixture();
    history.reset({ layout });
    layout.panelExport.gapMm = 1.25;
    history.record({ layout });
    layout.panelExport.groups = [];
    history.record({ layout });
    const undoDelete = history.undo();
    assert.equal(undoDelete.layout.panelExport.groups.length, 1);
    assert.equal(undoDelete.layout.panelExport.gapMm, 1.25);
    undoDelete.layout.panelExport.groups[0].cells.pop();
    assert.equal(history.undo().layout.panelExport.gapMm, 0);
    assert.equal(history.redo().layout.panelExport.groups[0].cells.length, 2);
    assert.equal(history.redo().layout.panelExport.groups.length, 0);
});
