// Shared DOM mapping for restoring a saved layout and undo/redo snapshots.
const fields = {
    grid: {
        columns: 'grid-cols', rows: 'grid-rows', hexSize: 'hex-size', orientation: 'hex-orientation',
        stagger: 'hex-stagger', gap: 'hex-gap', dpi: 'export-dpi', exportFormat: 'export-format',
        exportQuality: 'export-quality'
    },
    bed: { verify: 'bed-verify', sizeX: 'bed-size-x', sizeY: 'bed-size-y' },
    frame: {
        enable: 'frame-enable', type: 'frame-type', width: 'frame-width', clearance: 'frame-clearance',
        height: 'frame-height', sleeveBase: 'frame-sleeve-base', color: 'frame-color', syncWidth: 'chk-sync-frame-width'
    },
    previewOptions: {
        showGaps: 'chk-preview-gaps', showLabels: 'chk-preview-labels', showFrames: 'chk-preview-frames',
        showRuler: 'chk-preview-ruler', background: 'preview-bg-select'
    }
};

export function applyLayoutFields(layout, root = document) {
    for (const [section, properties] of Object.entries(fields)) {
        for (const [key, id] of Object.entries(properties)) {
            const value = layout[section]?.[key];
            const input = root.getElementById(id);
            if (!input) continue;
            if (id === 'export-dpi') {
                input.querySelector('[data-custom-dpi]')?.remove();
                if (value !== undefined && ![...input.options].some(option => option.value === String(value))) {
                    const option = new Option(`${value} DPI`, String(value));
                    option.dataset.customDpi = '';
                    input.add(option);
                }
            }
            if (input.type === 'checkbox') input.checked = value ?? input.defaultChecked;
            else if (value !== undefined) input.value = String(value);
            else if (input.options) input.value = ([...input.options].find(option => option.defaultSelected) ?? input.options[0]).value;
            else input.value = input.defaultValue;
        }
    }
    const imageMode = layout.imageMode ?? 'single';
    root.querySelectorAll('input[name="image-mode"]').forEach(input => { input.checked = input.value === imageMode; });
}
