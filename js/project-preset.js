import { validateProjectLayout } from './project-validation.js';

export const MAX_PRESET_BYTES = 512 * 1024;
const VERSION = 1;
const FORMAT = 'hexsplitter-preset';
const SETTINGS = {
    grid: ['topology', 'columns', 'rows', 'hexSize', 'orientation', 'stagger', 'gap', 'dpi', 'exportFormat', 'exportQuality'],
    bed: ['verify', 'sizeX', 'sizeY'],
    frame: ['enable', 'type', 'width', 'clearance', 'height', 'sleeveBase', 'color', 'syncWidth'],
    previewOptions: ['showGaps', 'showLabels', 'showFrames', 'showRuler', 'background']
};

function settingsOnly(layout) {
    const settings = {};
    for (const [section, keys] of Object.entries(SETTINGS)) {
        const source = layout[section];
        if (!source) continue;
        settings[section] = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    }
    settings.imageMode = layout.imageMode;
    settings.cells = layout.cells.map(({ q, r, shape }) => ({ q, r, shape }));
    settings.panelExport = layout.panelExport;
    return settings;
}

export function createPresetBlob(layout) {
    const validated = validateProjectLayout(structuredClone(layout));
    return new Blob([JSON.stringify({ format: FORMAT, version: VERSION, layout: settingsOnly(validated) }, null, 2)],
        { type: 'application/json' });
}

export async function readPresetFile(file) {
    if (!(file instanceof Blob) || file.size > MAX_PRESET_BYTES) throw new Error('Invalid preset size');
    const { format, version, layout } = JSON.parse(await file.text());
    if (format !== FORMAT || version !== VERSION || layout?.grid?.topology !== 'explicit') {
        throw new Error('Unsupported preset format');
    }
    const validated = validateProjectLayout(layout);
    return { ...settingsOnly(validated), activeImageId: null };
}
