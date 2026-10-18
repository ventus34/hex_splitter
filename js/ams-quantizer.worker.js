import { quantizeRgbaPixels } from './ams-quantizer.js';

self.addEventListener('message', event => {
    const request = event.data;
    if (!request || request.type !== 'quantize') return;

    try {
        const pixels = new Uint8ClampedArray(request.pixels);
        quantizeRgbaPixels(pixels, request.colorCount);
        self.postMessage({
            type: 'quantized',
            id: request.id,
            key: request.key,
            width: request.width,
            height: request.height,
            colorCount: request.colorCount,
            pixels: pixels.buffer
        }, [pixels.buffer]);
    } catch (error) {
        self.postMessage({
            type: 'error',
            id: request.id,
            message: error instanceof Error ? error.message : String(error)
        });
    }
});
