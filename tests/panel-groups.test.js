import test from 'node:test';
import assert from 'node:assert/strict';
import GridManager from '../js/grid-manager.js';
import HexMath from '../js/hex-math.js';
import {
    defaultPanelExport, validatePanelExport, upsertPanelGroup, removePanelGroup,
    reconcilePanelGroups, resolveGroupCells, arePanelCellsConnected
} from '../js/panel-groups.js';

function grid(orientation = 'flat-top', stagger = 'left') {
    const manager = new GridManager();
    manager.updateConfig({ columns: 4, rows: 4, orientation, stagger });
    return manager;
}

function neighborPair(manager) {
    const first = manager.getAllCells().find(cell => cell.col === 1 && cell.row === 1);
    for (let edge = 0; edge < 6; edge++) {
        const delta = HexMath.getNeighborOffset(edge, manager.config.orientation, manager.config.stagger, first.q, first.r);
        const second = manager.getCell(first.q + delta.q, first.r + delta.r);
        if (second) return [first, second];
    }
    throw new Error('No neighbor found in test grid');
}

for (const orientation of ['flat-top', 'pointy-top']) {
    for (const stagger of ['left', 'right']) {
        test(`groups validate rendered neighbors for ${orientation} / ${stagger}`, () => {
            const manager = grid(orientation, stagger);
            const [first, second] = neighborPair(manager);
            const state = defaultPanelExport();
            const group = upsertPanelGroup(state, [first, second], manager);
            assert.equal(group.cells.length, 2);
            assert.equal(arePanelCellsConnected(resolveGroupCells(group, manager), manager.config), true);
            assert.deepEqual(validatePanelExport(state, manager.config, manager.getAllCells()), state);
            assert.equal(removePanelGroup(state, group.id), true);
            assert.deepEqual(state.groups, []);
        });
    }
}

test('edits are atomic and reject disconnected, duplicate, overlapping or inactive members', () => {
    const manager = grid();
    const [first, second] = neighborPair(manager);
    const far = manager.getAllCells().find(cell => cell.col === 3 && cell.row === 3);
    const state = defaultPanelExport();
    const group = upsertPanelGroup(state, [first, second], manager);
    const previous = structuredClone(state);
    assert.throws(() => upsertPanelGroup(state, [first, far], manager, group.id), { code: 'PANEL_DISCONNECTED' });
    assert.throws(() => upsertPanelGroup(state, [first, first], manager, group.id), { code: 'PANEL_CELL_DUPLICATE' });
    assert.throws(() => upsertPanelGroup(state, [first, second], manager), { code: 'PANEL_CELL_CONFLICT' });
    second.enabled = false;
    assert.throws(() => upsertPanelGroup(state, [first, second], manager, group.id), { code: 'PANEL_CELL_UNAVAILABLE' });
    assert.deepEqual(state, previous);
    assert.equal(reconcilePanelGroups(state, manager), 1);
    assert.deepEqual(state.groups, []);
});

test('layout validation accepts old projects and rejects malformed panel data and unavailable references', () => {
    const manager = grid('pointy-top', 'right');
    const [first, second] = neighborPair(manager);
    assert.deepEqual(validatePanelExport(undefined, manager.config), defaultPanelExport());
    const state = { gapMm: 0, groups: [{ id: 'panel_1', cells: [first, second] }] };
    assert.deepEqual(validatePanelExport(state, manager.config).groups[0].cells,
        [first, second].map(({ q, r }) => ({ q, r })));
    assert.throws(() => validatePanelExport({ ...state, gapMm: -0.1 }, manager.config), { code: 'PANEL_INVALID_GAP' });
    assert.throws(() => validatePanelExport({ ...state, gapMm: 50.01 }, manager.config), { code: 'PANEL_INVALID_GAP' });
    assert.throws(() => validatePanelExport({ ...state, groups: [{ ...state.groups[0], id: '../bad' }] }, manager.config), { code: 'PANEL_INVALID_ID' });
    assert.throws(() => validatePanelExport(state, manager.config, [{ q: first.q, r: first.r, enabled: false }]), { code: 'PANEL_CELL_UNAVAILABLE' });
    const outside = { gapMm: 0, groups: [{ id: 'x', cells: [{ q: 99, r: 99 }, { q: 99, r: 100 }] }] };
    assert.throws(() => validatePanelExport(outside, manager.config), { code: 'PANEL_CELL_UNAVAILABLE' });
});

test('grid topology change dissolves the affected group', () => {
    const manager = grid();
    const first = manager.getAllCells().find(cell => cell.col === 3 && cell.row === 2);
    const second = manager.getAllCells().find(cell => cell.col === 3 && cell.row === 3);
    const state = defaultPanelExport();
    upsertPanelGroup(state, [first, second], manager);
    manager.updateConfig({ columns: 3 });
    assert.equal(reconcilePanelGroups(state, manager), 1);
});

test('connected groups may contain more than three cells and be edited atomically', () => {
    const manager = grid();
    const members = [0, 1, 2, 3].map(row => manager.getCell(0, row));
    const state = defaultPanelExport();
    const group = upsertPanelGroup(state, members, manager);
    assert.equal(group.cells.length, 4);
    const edited = upsertPanelGroup(state, members.slice(0, 3), manager, group.id);
    assert.equal(edited.id, group.id);
    assert.equal(edited.cells.length, 3);
    assert.deepEqual(validatePanelExport(state, manager.config, manager.getAllCells()), state);
});
