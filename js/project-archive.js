import {
    PROJECT_LIMITS, PROJECT_SCHEMA_VERSION, inferImageMimeType, validateProjectArchiveMetadata
} from './project-validation.js?v=1.0.3';

/** Immutable source Blobs are streamed unchanged; only the manifest is encoded. */
export async function createProjectArchiveEntries(images, layout, { signal } = {}) {
    const entries = [];
    const imagesMeta = [];
    for (const image of images) {
        signal?.throwIfAborted();
        if (!(image.blob instanceof Blob)) throw new Error('Brakuje danych obrazu projektu.');
        const mimeType = await inferImageMimeType(image.blob, image.name);
        if (!mimeType) throw new Error(`Nie można określić typu obrazu ${image.name || image.id}.`);
        const filename = `images/${image.id}`;
        imagesMeta.push({
            id: image.id, name: image.name, mimeType,
            width: image.width, height: image.height,
            rotation: image.rotation ?? 0, zoom: image.zoom ?? 1, filename
        });
        entries.push({ name: filename, label: filename, blob: image.blob });
    }
    signal?.throwIfAborted();
    const projectData = { schemaVersion: PROJECT_SCHEMA_VERSION, layout, images: imagesMeta };
    const manifest = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    if (manifest.size > 5 * 1024 * 1024) throw new Error('Opis projektu jest zbyt duży.');
    entries.unshift({ name: 'project.json', label: 'project.json', blob: manifest });

    // Reuse the import validator through its archive metadata interface. No ZIP
    // contents are buffered here, and invalid local records cannot produce a
    // metadata which our importer would refuse to accept.
    const files = Object.fromEntries(entries.map(entry => [entry.name, {
        dir: false, _data: { uncompressedSize: entry.blob.size }
    }]));
    const metadata = { files, file: name => files[name] };
    const encoder = new TextEncoder();
    const zipBytes = 22 + entries.reduce((sum, entry) =>
        sum + entry.blob.size + 92 + 2 * encoder.encode(entry.name).byteLength, 0);
    validateProjectArchiveMetadata(projectData, metadata, zipBytes);
    if (zipBytes > PROJECT_LIMITS.maxArchiveBytes) throw new Error('Plik projektu jest zbyt duży.');
    return entries;
}
