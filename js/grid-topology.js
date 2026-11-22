export const MAX_GRID_DIMENSION = 25;
export const MAX_GRID_CELLS = MAX_GRID_DIMENSION ** 2;

export const cellKey = (q, r) => `${q},${r}`;

export function toAxial(col, row, orientation) {
    return orientation === 'flat-top'
        ? { q: col, r: row - Math.floor(col / 2) }
        : { q: col - Math.floor(row / 2), r: row };
}

export function toOffset(q, r, orientation) {
    return orientation === 'flat-top'
        ? { col: q, row: r + Math.floor(q / 2) }
        : { col: q + Math.floor(r / 2), row: r };
}

export function starterCoordinates(columns, rows, orientation) {
    const cells = [];
    for (let col = 0; col < columns; col++) {
        for (let row = 0; row < rows; row++) cells.push(toAxial(col, row, orientation));
    }
    return cells;
}

export function cellLabel(col, row) {
    let index = col < 0 ? -col - 1 : col;
    let letters = '';
    while (index >= 0) {
        letters = String.fromCharCode(65 + index % 26) + letters;
        index = Math.floor(index / 26) - 1;
    }
    return `${col < 0 ? '-' : ''}${letters}${row >= 0 ? row + 1 : row}`;
}

export function getGridExtent(cells, orientation) {
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (const { q, r } of cells) {
        const { col, row } = toOffset(q, r, orientation);
        minCol = Math.min(minCol, col);
        maxCol = Math.max(maxCol, col);
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
    }
    return { minCol, maxCol, minRow, maxRow };
}

export function canStoreCoordinate(q, r, orientation) {
    if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r)) return false;
    // Bound the stable offset slot, including when a tile changes orientation.
    const { col, row } = toOffset(q, r, orientation);
    return Math.abs(col) <= 1_000_000 && Math.abs(row) <= 1_000_000;
}

export function isGridExtentValid({ minCol, maxCol, minRow, maxRow }) {
    return maxCol - minCol < MAX_GRID_DIMENSION && maxRow - minRow < MAX_GRID_DIMENSION;
}
