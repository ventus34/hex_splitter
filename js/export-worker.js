import STLHexGenerator from './stl-hex-generator.js?v=1.0.3';

/** Install the small protocol used by ExportWorkerClient. Exported for node tests. */
export function installSTLExportWorker(scope = globalThis) {
    const images = new Map();

    scope.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'init') {
            images.clear();
            for (const entry of message.images || []) {
                if (entry?.id && entry.bitmap) images.set(entry.id, entry.bitmap);
            }
            scope.postMessage({ type: 'ready' });
            return;
        }

        if (message.type === 'dispose') {
            for (const image of images.values()) image.close?.();
            images.clear();
            scope.close?.();
            return;
        }

        if (message.type !== 'generate') return;
        try {
            const bitmap = images.get(message.cell?.imageId);
            if (!bitmap) throw new Error('The source image is unavailable in the export worker.');
            const image = { id: message.cell.imageId, imgElement: bitmap };
            const processor = {
                getImage: id => id === image.id ? image : null,
                getRotatedCanvasOrImage: source => source.imgElement
            };
            const buffer = STLHexGenerator.generateHexSTL(
                message.cell,
                { config: message.gridConfig },
                processor,
                message.options
            );
            if (!(buffer instanceof ArrayBuffer)) throw new Error('Relief STL generation failed.');
            scope.postMessage({ type: 'result', requestId: message.requestId, buffer }, [buffer]);
        } catch (error) {
            scope.postMessage({
                type: 'error',
                requestId: message.requestId,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    installSTLExportWorker(globalThis);
}
