import HexMath from './hex-math.js';

const MAX_CELLS = 625;
const keyOf = cell => `${cell.q},${cell.r}`;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

export function defaultPanelExport() {
    return { gapMm: 0, groups: [] };
}

/** Layout coordinates follow GridManager.generateGrid(), including pointy-top rows. */
function layoutCellMap(config, savedCells) {
    const columns = config.columns ?? 4;
    const rows = config.rows ?? 3;
    const orientation = config.orientation ?? 'flat-top';
    const saved = new Map((savedCells || []).map(cell => [keyOf(cell), cell]));
    const result = new Map();
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 ||
        columns > 25 || rows > 25 || !['flat-top', 'pointy-top'].includes(orientation)) {
        fail('PANEL_INVALID_STATE', 'Invalid panel grid.');
    }
    for (let col = 0; col < columns; col++) {
        for (let row = 0; row < rows; row++) {
            const q = orientation === 'flat-top' ? col : col - Math.floor(row / 2);
            const r = orientation === 'flat-top' ? row - Math.floor(col / 2) : row;
            const value = saved.get(`${q},${r}`);
            result.set(`${q},${r}`, { q, r, enabled: value?.enabled ?? true });
        }
    }
    return result;
}

/** Connectivity uses actual rendered neighbor offsets, including right stagger. */
export function arePanelCellsConnected(cells, config) {
    if (!Array.isArray(cells) || cells.length === 0) return false;
    const coordinates = new Map(cells.map(cell => [keyOf(cell), cell]));
    const pending = [cells[0]];
    const visited = new Set([keyOf(cells[0])]);
    for (let index = 0; index < pending.length; index++) {
        const cell = pending[index];
        for (let edge = 0; edge < 6; edge++) {
            const offset = HexMath.getNeighborOffset(edge, config.orientation ?? 'flat-top', config.stagger ?? 'left', cell.q, cell.r);
            if (!offset) continue;
            const key = `${cell.q + offset.q},${cell.r + offset.r}`;
            const neighbor = coordinates.get(key);
            if (neighbor && !visited.has(key)) {
                visited.add(key);
                pending.push(neighbor);
            }
        }
    }
    return visited.size === cells.length;
}

function validateGroups(state, config, available) {
    if (!isRecord(state)) fail('PANEL_INVALID_STATE', 'Invalid panel settings.');
    if (typeof state.gapMm !== 'number' || !Number.isFinite(state.gapMm) || state.gapMm < 0 || state.gapMm > 50) {
        fail('PANEL_INVALID_GAP', 'Panel gap must be between 0 and 50 mm.');
    }
    if (!Array.isArray(state.groups) || state.groups.length > Math.floor(MAX_CELLS / 2)) {
        fail('PANEL_INVALID_STATE', 'Invalid panel groups.');
    }
    const ids = new Set();
    const used = new Set();
    const groups = state.groups.map(group => {
        if (!isRecord(group) || typeof group.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(group.id) || ids.has(group.id)) {
            fail('PANEL_INVALID_ID', 'Invalid or repeated panel identifier.');
        }
        ids.add(group.id);
        if (!Array.isArray(group.cells) || group.cells.length < 2 || group.cells.length > MAX_CELLS) {
            fail('PANEL_INVALID_CELLS', 'A panel must contain at least two hexes.');
        }
        const local = new Set();
        const cells = group.cells.map(cell => {
            if (!isRecord(cell) || !Number.isInteger(cell.q) || !Number.isInteger(cell.r)) {
                fail('PANEL_INVALID_CELLS', 'Invalid panel hex coordinates.');
            }
            const key = keyOf(cell);
            if (local.has(key)) fail('PANEL_CELL_DUPLICATE', 'A hex appears twice in the panel.');
            if (used.has(key)) fail('PANEL_CELL_CONFLICT', 'A hex already belongs to another panel.');
            const member = available(key);
            if (!member || !member.enabled) fail('PANEL_CELL_UNAVAILABLE', 'A panel hex is missing or inactive.');
            local.add(key);
            used.add(key);
            return { q: cell.q, r: cell.r };
        });
        if (!arePanelCellsConnected(cells, config)) fail('PANEL_DISCONNECTED', 'Panel hexes must be connected by edges.');
        return { id: group.id, cells };
    });
    return { gapMm: state.gapMm, groups };
}

/** Validate persisted JSON without depending on GridManager or image availability. */
export function validatePanelExport(state, config = {}, savedCells = []) {
    if (state === undefined) return defaultPanelExport();
    const available = layoutCellMap(config, savedCells);
    return validateGroups(state, config, key => available.get(key));
}

export function resolveGroupCells(group, grid) {
    return (group?.cells || []).map(({ q, r }) => grid.getCell(q, r));
}

let nextId = 0;
function makeId(groups) {
    let id;
    do {
        const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now().toString(36)}_${(++nextId).toString(36)}`;
        id = `panel_${random}`;
    } while (groups.some(group => group.id === id));
    return id;
}

/** Apply an entire group edit atomically; invalid edits leave state unchanged. */
export function upsertPanelGroup(state, coords, grid, id = null) {
    if (!isRecord(state) || !Array.isArray(state.groups)) fail('PANEL_INVALID_STATE', 'Invalid panel settings.');
    const index = id === null ? -1 : state.groups.findIndex(group => group.id === id);
    if (id !== null && index < 0) fail('PANEL_INVALID_ID', 'The panel no longer exists.');
    const group = { id: id ?? makeId(state.groups), cells: coords };
    const groups = state.groups.slice();
    if (index < 0) groups.push(group);
    else groups[index] = group;
    const validated = validateGroups({ gapMm: state.gapMm, groups }, grid.config, key => grid.cells.get(key));
    state.groups = validated.groups;
    return state.groups[index < 0 ? state.groups.length - 1 : index];
}

export function removePanelGroup(state, id) {
    const index = state.groups.findIndex(group => group.id === id);
    if (index < 0) return false;
    state.groups.splice(index, 1);
    return true;
}

/** A topology edit dissolves each affected group as a single project change. */
export function reconcilePanelGroups(state, grid) {
    if (!state?.groups) return 0;
    const before = state.groups.length;
    state.groups = state.groups.filter(group => {
        const cells = resolveGroupCells(group, grid);
        return cells.length >= 2 && cells.every(cell => cell?.enabled) && arePanelCellsConnected(cells, grid.config);
    });
    return before - state.groups.length;
}
