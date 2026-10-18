import test from 'node:test';
import assert from 'node:assert/strict';
import ProjectHistory from '../js/project-history.js';

const layout = (rotation, savedAt = '2026-10-18T00:00:00.000Z') => ({
    grid: { columns: 2, rows: 1, orientation: 'flat-top' },
    images: [{ id: 'img-1', rotation, zoom: 1 }],
    savedAt
});

test('undo and redo return isolated snapshot copies', () => {
    const history = new ProjectHistory();
    const first = layout(0);
    history.reset(first);
    first.images[0].rotation = 90;
    history.record(layout(90));

    const undone = history.undo();
    assert.equal(undone.images[0].rotation, 0);
    undone.images[0].rotation = 180;
    assert.equal(history.current.images[0].rotation, 0);

    const redone = history.redo();
    assert.equal(redone.images[0].rotation, 90);
    redone.images[0].rotation = 270;
    assert.equal(history.current.images[0].rotation, 90);
});

test('stable deduplication ignores object key order and savedAt', () => {
    const history = new ProjectHistory();
    history.reset({ grid: { columns: 2, rows: 1 }, rotation: 30, savedAt: 'before' });

    const recorded = history.record({ savedAt: 'after', rotation: 30, grid: { rows: 1, columns: 2 } });

    assert.equal(recorded, false);
    assert.equal(history.size, 1);
    assert.equal(history.canUndo, false);
    assert.equal(history.current.savedAt, 'before');
});

test('recording after undo discards the redo branch', () => {
    const history = new ProjectHistory();
    history.reset(layout(0));
    history.record(layout(90));
    history.record(layout(180));

    assert.equal(history.undo().images[0].rotation, 90);
    assert.equal(history.canRedo, true);
    history.record(layout(45));

    assert.equal(history.canRedo, false);
    assert.equal(history.redo(), null);
    assert.equal(history.undo().images[0].rotation, 90);
});

test('history capacity bounds retained snapshots and preserves undo to oldest retained state', () => {
    const history = new ProjectHistory({ maxEntries: 3 });
    history.reset(layout(0));
    history.record(layout(45));
    history.record(layout(90));
    history.record(layout(135));

    assert.equal(history.size, 3);
    assert.equal(history.current.images[0].rotation, 135);
    assert.equal(history.undo().images[0].rotation, 90);
    assert.equal(history.undo().images[0].rotation, 45);
    assert.equal(history.undo(), null);
});

test('explicit gesture groups coalesce multiple snapshots into one undo step', () => {
    const history = new ProjectHistory();
    history.reset(layout(0));
    history.beginGroup('rotate-drag');
    history.record(layout(15));
    history.record(layout(30));
    history.record(layout(45));
    assert.equal(history.endGroup('rotate-drag'), true);

    assert.equal(history.size, 2);
    assert.equal(history.undo().images[0].rotation, 0);
    assert.equal(history.redo().images[0].rotation, 45);
});

test('mergeKey coalesces rapid edits but starts a new step outside the time window', () => {
    const history = new ProjectHistory({ mergeWindowMs: 500 });
    history.reset(layout(0));
    history.record(layout(10), { mergeKey: 'rotation:img-1', timestamp: 1000 });
    history.record(layout(20), { mergeKey: 'rotation:img-1', timestamp: 1300 });
    history.record(layout(30), { mergeKey: 'rotation:img-1', timestamp: 1801 });

    assert.equal(history.size, 3);
    assert.equal(history.undo().images[0].rotation, 20);
    assert.equal(history.undo().images[0].rotation, 0);
});

test('snapshots omit blob and runtime media data', () => {
    const history = new ProjectHistory();
    history.reset({
        images: [{ id: 'img-1', name: 'source.png', blob: new Blob(['image']), width: 20 }],
        preview: { imageBlob: new Blob(['preview']), objectUrl: 'blob:preview', canvas: { marker: true } },
        rotation: 15
    });

    assert.deepEqual(history.current, {
        images: [{ id: 'img-1', name: 'source.png', width: 20 }],
        preview: {},
        rotation: 15
    });
});

test('beginGroup rejects a conflicting open group and can be ended by key', () => {
    const history = new ProjectHistory();
    history.reset(layout(0));
    history.beginGroup('drag');

    assert.throws(() => history.beginGroup('other'), /already open/);
    assert.equal(history.endGroup('other'), false);
    assert.equal(history.endGroup('drag'), true);
});
