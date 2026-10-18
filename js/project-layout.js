// Shared DOM mapping for restoring a saved layout and undo/redo snapshots.
const fields = {
    grid: {
        columns: 'grid-cols', rows: 'grid-rows', hexSize: 'hex-size', orientation: 'hex-orientation',
        stagger: 'hex-stagger', gap: 'hex-gap', dpi: 'export-dpi', exportFormat: 'export-format',
        exportQuality: 'export-quality', halfHexes: 'grid-half-hexes'
    },
    bed: { verify: 'bed-verify', sizeX: 'bed-size-x', sizeY: 'bed-size-y' },
    frame: {
        enable: 'frame-enable', type: 'frame-type', width: 'frame-width', clearance: 'frame-clearance',
        height: 'frame-height', sleeveBase: 'frame-sleeve-base', color: 'frame-color', syncWidth: 'chk-sync-frame-width'
    },
    relief: {
        enable: 'relief-enable', height: 'relief-height', baseThickness: 'relief-base-thickness',
        invert: 'relief-invert', sectors: 'relief-sectors', rings: 'relief-rings', blur: 'relief-blur'
    },
    hanger: {
        clearance: 'hanger-clearance', baseThickness: 'hanger-base-thickness', ridgeHeight: 'hanger-ridge-height',
        armWidth: 'hanger-arm-width', armLength: 'hanger-arm-length'
    },
    previewOptions: {
        showGaps: 'chk-preview-gaps', showLabels: 'chk-preview-labels', showFrames: 'chk-preview-frames',
        showRuler: 'chk-preview-ruler', showHangers: 'chk-preview-hangers', background: 'preview-bg-select'
    }
};

export function applyLayoutFields(layout, root = document) {
    for (const [section, properties] of Object.entries(fields)) {
        for (const [key, id] of Object.entries(properties)) {
            const value = layout[section]?.[key];
            const input = root.getElementById(id);
            if (value === undefined || !input) continue;
            if (input.type === 'checkbox') input.checked = value;
            else input.value = String(value);
        }
    }
    if (layout.imageMode) {
        root.querySelectorAll('input[name="image-mode"]').forEach(input => { input.checked = input.value === layout.imageMode; });
    }
}
