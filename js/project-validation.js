export const PROJECT_SCHEMA_VERSION = 2;
export const PROJECT_LAYOUT_RECORD_ID = '__hexsplitter_project_layout__';
export const PROJECT_LIMITS = Object.freeze({
    maxArchiveBytes: 250 * 1024 * 1024,
    maxUncompressedBytes: 300 * 1024 * 1024,
    maxImageBytes: 50 * 1024 * 1024,
    maxImages: 625,
    maxImagePixels: 50_000_000,
    maxTotalImagePixels: 150_000_000,
    maxGridDimension: 25,
    maxCells: 625
});
export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml', 'image/avif', 'image/tiff'
]);

const MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff'
});

export function parseBoundedNumber(value, fallback, min = -Infinity, max = Infinity) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

export function assertImageDimensions(width, height, totalPixels = PROJECT_LIMITS.maxImagePixels) {
    requireCondition(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0,
        'Wymiary obrazu są niepoprawne.');
    requireCondition(width * height <= PROJECT_LIMITS.maxImagePixels && width * height <= totalPixels,
        'Obraz przekracza dozwoloną rozdzielczość.');
}

export async function inferImageMimeType(blob, name = '') {
    const declared = typeof blob?.type === 'string' ? blob.type.split(';', 1)[0].trim().toLowerCase() : '';
    if (SUPPORTED_IMAGE_MIME_TYPES.includes(declared)) return declared;

    const extension = typeof name === 'string' ? name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() : null;
    if (extension && MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension];

    if (!(blob instanceof Blob) || blob.size < 2) return null;
    const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
    if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
    if (ascii(0, 2) === 'BM') return 'image/bmp';
    const prefix = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trimStart();
    if (/^(?:(?:<\?xml\b[\s\S]*?\?>|<!doctype\b[^>]*>|<!--[\s\S]*?-->)\s*)*<svg\b/i.test(prefix)) return 'image/svg+xml';
    return null;
}

export async function normalizeProjectImageBlob(blob, mimeType, name = '') {
    const declared = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
    const inferred = declared || await inferImageMimeType(blob, name);
    if (!SUPPORTED_IMAGE_MIME_TYPES.includes(inferred)) throw new Error(`Nieobsługiwany format obrazu: ${name || 'bez nazwy'}.`);
    if (blob.type === inferred) return blob;
    return new Blob([blob], { type: inferred });
}

export function validateProjectLayout(layout) {
    requireCondition(isRecord(layout), 'Projekt nie zawiera poprawnego układu.');
    requireCondition(isRecord(layout.grid), 'Projekt nie zawiera konfiguracji siatki.');

    const { grid } = layout;
    for (const [key, fallback] of [['columns', 4], ['rows', 3]]) {
        if (grid[key] !== undefined) {
            requireCondition(Number.isInteger(grid[key]) && grid[key] >= 1 && grid[key] <= PROJECT_LIMITS.maxGridDimension,
                `Niepoprawna wartość ${key} w projekcie.`);
        } else {
            grid[key] = fallback;
        }
    }
    requireCondition(grid.columns * grid.rows <= PROJECT_LIMITS.maxCells, 'Siatka w projekcie jest zbyt duża.');

    const numericFields = [
        ['hexSize', 10, 500], ['gap', 0, 50], ['singleImageOffsetX', -100_000, 100_000],
        ['singleImageOffsetY', -100_000, 100_000], ['singleImageScale', 0.2, 5]
    ];
    for (const [key, min, max] of numericFields) {
        if (grid[key] !== undefined) {
            requireCondition(isFiniteNumber(grid[key]) && grid[key] >= min && grid[key] <= max,
                `Niepoprawna wartość ${key} w projekcie.`);
        }
    }

    requireCondition(grid.orientation === undefined || ['flat-top', 'pointy-top'].includes(grid.orientation),
        'Nieznana orientacja heksów w projekcie.');
    requireCondition(grid.stagger === undefined || ['left', 'right'].includes(grid.stagger),
        'Nieznany układ przesunięcia siatki w projekcie.');
    if (grid.dpi !== undefined) {
        requireCondition(grid.dpi === 'original' || (Number.isInteger(Number(grid.dpi)) && Number(grid.dpi) >= 72 && Number(grid.dpi) <= 1200),
            'Niepoprawna rozdzielczość eksportu w projekcie.');
    }
    if (grid.exportFormat !== undefined) requireCondition(['png', 'jpg'].includes(grid.exportFormat), 'Nieznany format eksportu w projekcie.');
    if (grid.exportQuality !== undefined) requireCondition(isFiniteNumber(grid.exportQuality) && grid.exportQuality >= 10 && grid.exportQuality <= 100,
        'Niepoprawna jakość eksportu w projekcie.');
    if (grid.halfHexes !== undefined) requireCondition(typeof grid.halfHexes === 'boolean', 'Niepoprawny wariant brzegów siatki.');
    requireCondition(layout.imageMode === undefined || ['single', 'multi', 'span'].includes(layout.imageMode),
        'Nieznany tryb obrazów w projekcie.');

    const cells = layout.cells === undefined ? [] : layout.cells;
    requireCondition(Array.isArray(cells) && cells.length <= PROJECT_LIMITS.maxCells, 'Lista komórek w projekcie jest niepoprawna.');
    const coordinates = new Set();
    for (const cell of cells) {
        requireCondition(isRecord(cell) && Number.isInteger(cell.q) && Number.isInteger(cell.r),
            'Projekt zawiera komórkę o niepoprawnych współrzędnych.');
        const key = `${cell.q},${cell.r}`;
        requireCondition(!coordinates.has(key), 'Projekt zawiera powtórzoną komórkę.');
        coordinates.add(key);
        requireCondition(cell.enabled === undefined || typeof cell.enabled === 'boolean', 'Niepoprawny stan komórki.');
        if (cell.cropRegion !== undefined && cell.cropRegion !== null) {
            const crop = cell.cropRegion;
            requireCondition(isRecord(crop) && ['x', 'y', 'w', 'h'].every(k => isFiniteNumber(crop[k])),
                'Projekt zawiera niepoprawny kadr obrazu.');
            requireCondition(crop.x >= -1_000_000 && crop.y >= -1_000_000 && crop.w > 0 && crop.h > 0 && crop.w <= 100_000_000 && crop.h <= 100_000_000,
                'Projekt zawiera kadr obrazu poza dozwolonym zakresem.');
        }
        for (const key of ['groupShiftX', 'groupShiftY']) {
            if (cell[key] !== undefined && cell[key] !== null) {
                requireCondition(isFiniteNumber(cell[key]) && Math.abs(cell[key]) <= 100_000, 'Niepoprawne przesunięcie kadru w projekcie.');
            }
        }
        if (cell.groupZoom !== undefined && cell.groupZoom !== null) {
            requireCondition(isFiniteNumber(cell.groupZoom) && cell.groupZoom >= 1 && cell.groupZoom <= 5, 'Niepoprawne powiększenie grupy.');
        }
        if (cell.groupId !== undefined && cell.groupId !== null) {
            requireCondition(typeof cell.groupId === 'string' && cell.groupId.length <= 100, 'Niepoprawny identyfikator grupy.');
        }
    }

    const sectionLimits = {
        bed: [['sizeX', 50, 1000], ['sizeY', 50, 1000]],
        frame: [['width', 1, 50], ['clearance', 0, 5], ['height', 1, 100], ['sleeveBase', 0.4, 20]],
        relief: [['height', 0.1, 50], ['baseThickness', 0.4, 50], ['sectors', 30, 360], ['rings', 15, 180], ['blur', 0, 5]],
        hanger: [['clearance', 0, 5], ['baseThickness', 0.5, 10], ['ridgeHeight', 1, 20], ['armWidth', 5, 100], ['armLength', 10, 200]]
    };
    for (const [section, fields] of Object.entries(sectionLimits)) {
        if (layout[section] === undefined) continue;
        requireCondition(isRecord(layout[section]), `Sekcja ${section} projektu jest niepoprawna.`);
        for (const [key, min, max] of fields) {
            const value = layout[section][key];
            if (value !== undefined) {
                requireCondition(isFiniteNumber(value) && value >= min && value <= max, `Niepoprawna wartość ${key} w projekcie.`);
            }
        }
    }
    for (const [section, keys] of Object.entries({
        bed: ['verify'], frame: ['enable', 'syncWidth'], relief: ['enable', 'invert'],
        previewOptions: ['showGaps', 'showLabels', 'showFrames', 'showRuler', 'showHangers']
    })) {
        if (layout[section] === undefined) continue;
        requireCondition(isRecord(layout[section]), `Sekcja ${section} projektu jest niepoprawna.`);
        for (const key of keys) {
            if (layout[section][key] !== undefined) requireCondition(typeof layout[section][key] === 'boolean', `Niepoprawna opcja ${key} w projekcie.`);
        }
    }
    if (layout.frame?.type !== undefined) requireCondition(['outline', 'backing', 'sleeve'].includes(layout.frame.type), 'Nieznany typ ramki w projekcie.');
    if (layout.frame?.color !== undefined) requireCondition(typeof layout.frame.color === 'string' && /^#[0-9a-f]{6}$/i.test(layout.frame.color), 'Niepoprawny kolor ramki w projekcie.');
    if (layout.previewOptions?.background !== undefined) {
        requireCondition(['transparent', 'dark', 'light', 'wall'].includes(layout.previewOptions.background), 'Nieznane tło podglądu w projekcie.');
    }
    return layout;
}

export function validateProjectArchiveMetadata(projectData, zip, archiveSize = 0) {
    requireCondition(isRecord(projectData), 'Plik projektu nie zawiera poprawnych danych.');
    const version = projectData.schemaVersion;
    requireCondition(version === undefined || version === PROJECT_SCHEMA_VERSION,
        'Ta wersja formatu projektu nie jest obsługiwana.');
    requireCondition(Array.isArray(projectData.images) && projectData.images.length <= PROJECT_LIMITS.maxImages,
        'Projekt zawiera zbyt wiele obrazów.');
    requireCondition(archiveSize <= PROJECT_LIMITS.maxArchiveBytes, 'Plik projektu jest zbyt duży.');
    const layout = validateProjectLayout(projectData.layout);

    let uncompressedBytes = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
        requireCondition(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'),
            'Archiwum zawiera niebezpieczną ścieżkę.');
        if (entry.dir) continue;
        const size = entry._data?.uncompressedSize;
        const compressedSize = entry._data?.compressedSize;
        requireCondition(Number.isFinite(size) && size >= 0, 'Archiwum nie zawiera wiarygodnych rozmiarów plików.');
        uncompressedBytes += size;
        requireCondition(size <= PROJECT_LIMITS.maxUncompressedBytes,
            'Plik w archiwum przekracza dozwolony rozmiar.');
        requireCondition(!Number.isFinite(compressedSize) || (compressedSize > 0 && (size <= 1024 * 1024 || size / compressedSize <= 1000)),
            'Archiwum zawiera nadmiernie skompresowany plik.');
    }
    requireCondition(uncompressedBytes <= PROJECT_LIMITS.maxUncompressedBytes,
        'Rozpakowana zawartość projektu jest zbyt duża.');

    const ids = new Set();
    const filenames = new Set();
    const images = projectData.images.map(meta => {
        requireCondition(isRecord(meta), 'Metadane obrazu w projekcie są niepoprawne.');
        requireCondition(typeof meta.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(meta.id) &&
            meta.id !== PROJECT_LAYOUT_RECORD_ID, 'Identyfikator obrazu jest niepoprawny.');
        requireCondition(!ids.has(meta.id), 'Projekt zawiera powtórzone identyfikatory obrazów.');
        ids.add(meta.id);
        requireCondition(typeof meta.name === 'string' && meta.name.length <= 500, 'Nazwa obrazu w projekcie jest niepoprawna.');
        requireCondition(meta.mimeType === undefined || (typeof meta.mimeType === 'string' && SUPPORTED_IMAGE_MIME_TYPES.includes(meta.mimeType.toLowerCase())),
            'Typ pliku obrazu w projekcie jest nieobsługiwany.');
        requireCondition(typeof meta.filename === 'string' && meta.filename.startsWith('images/') &&
            meta.filename.length <= 220 && !meta.filename.split('/').includes('..'), 'Ścieżka obrazu w projekcie jest niepoprawna.');
        requireCondition(!filenames.has(meta.filename), 'Projekt wskazuje ten sam plik obrazu kilka razy.');
        filenames.add(meta.filename);
        requireCondition(Number.isInteger(meta.width) && Number.isInteger(meta.height), 'Wymiary obrazu w projekcie są niepoprawne.');
        assertImageDimensions(meta.width, meta.height);
        requireCondition(meta.rotation === undefined || (isFiniteNumber(meta.rotation) && meta.rotation >= 0 && meta.rotation <= 360),
            'Kąt obrotu obrazu w projekcie jest niepoprawny.');
        requireCondition(meta.zoom === undefined || (isFiniteNumber(meta.zoom) && meta.zoom >= 1 && meta.zoom <= 5),
            'Powiększenie obrazu w projekcie jest niepoprawne.');
        const rotation = meta.rotation ?? 0;
        const radians = rotation * Math.PI / 180;
        const rotatedWidth = Math.round(meta.width * Math.abs(Math.cos(radians)) + meta.height * Math.abs(Math.sin(radians)));
        const rotatedHeight = Math.round(meta.width * Math.abs(Math.sin(radians)) + meta.height * Math.abs(Math.cos(radians)));
        requireCondition(rotatedWidth <= 32768 && rotatedHeight <= 32768 && rotatedWidth * rotatedHeight <= PROJECT_LIMITS.maxImagePixels,
            `Obrócony obraz ${meta.name || meta.id} przekracza dozwolony rozmiar.`);
        const entry = zip.file(meta.filename);
        requireCondition(entry && !entry.dir, `Brakuje pliku obrazu ${meta.name || meta.id} w archiwum.`);
        const fileSize = entry._data?.uncompressedSize;
        requireCondition(Number.isFinite(fileSize) && fileSize > 0 && fileSize <= PROJECT_LIMITS.maxImageBytes,
            `Plik obrazu ${meta.name || meta.id} jest zbyt duży.`);
        return { meta, entry };
    });

    let totalPixels = 0;
    for (const { meta } of images) totalPixels += meta.width * meta.height;
    requireCondition(totalPixels <= PROJECT_LIMITS.maxTotalImagePixels, 'Łączna rozdzielczość obrazów w projekcie jest zbyt duża.');
    const imageIds = new Set(images.map(({ meta }) => meta.id));
    if (layout.activeImageId !== undefined && layout.activeImageId !== null) {
        requireCondition(imageIds.has(layout.activeImageId), 'Aktywny obraz nie występuje w archiwum projektu.');
    }
    for (const cell of layout.cells || []) {
        if (cell.imageId !== undefined && cell.imageId !== null) {
            requireCondition(imageIds.has(cell.imageId), 'Komórka odwołuje się do brakującego obrazu.');
        }
    }

    return images;
}
