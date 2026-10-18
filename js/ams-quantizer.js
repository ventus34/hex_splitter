/**
 * Deterministically quantize RGBA pixels in place using the preview's palette
 * selection and five-pass k-means mapping. Alpha is preserved.
 */
export function quantizeRgbaPixels(data, requestedColorCount) {
    const colorCount = Math.max(1, Math.floor(Number(requestedColorCount) || 1));
    const pixels = [];

    // Sample one pixel from each 30-pixel span, matching the previous preview
    // implementation and keeping palette selection stable across worker/fallback.
    for (let i = 0; i < data.length; i += 120) {
        if (data[i + 3] > 50) pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (pixels.length < colorCount) return data;

    const centroids = [pixels[0]];
    for (let k = 1; k < colorCount; k++) {
        let maxDistSq = -1;
        let nextCentroid = null;
        for (let i = 0; i < pixels.length; i += 10) {
            const pixel = pixels[i];
            let minDistSq = Infinity;
            for (const centroid of centroids) {
                const distSq = (pixel[0] - centroid[0]) ** 2
                    + (pixel[1] - centroid[1]) ** 2
                    + (pixel[2] - centroid[2]) ** 2;
                if (distSq < minDistSq) minDistSq = distSq;
            }
            if (minDistSq > maxDistSq) {
                maxDistSq = minDistSq;
                nextCentroid = pixel;
            }
        }
        centroids.push(nextCentroid || pixels[k % pixels.length]);
    }

    for (let iter = 0; iter < 5; iter++) {
        const sums = new Float64Array(colorCount * 3);
        const counts = new Uint32Array(colorCount);
        for (const pixel of pixels) {
            let minDistSq = Infinity;
            let groupIdx = 0;
            for (let c = 0; c < colorCount; c++) {
                const centroid = centroids[c];
                const distSq = (pixel[0] - centroid[0]) ** 2
                    + (pixel[1] - centroid[1]) ** 2
                    + (pixel[2] - centroid[2]) ** 2;
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    groupIdx = c;
                }
            }
            counts[groupIdx]++;
            sums[groupIdx * 3] += pixel[0];
            sums[groupIdx * 3 + 1] += pixel[1];
            sums[groupIdx * 3 + 2] += pixel[2];
        }

        for (let c = 0; c < colorCount; c++) {
            if (counts[c] === 0) continue;
            centroids[c] = [
                Math.round(sums[c * 3] / counts[c]),
                Math.round(sums[c * 3 + 1] / counts[c]),
                Math.round(sums[c * 3 + 2] / counts[c])
            ];
        }
    }

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 50) continue;
        const red = data[i];
        const green = data[i + 1];
        const blue = data[i + 2];
        let minDistSq = Infinity;
        let nearest = centroids[0];
        for (const centroid of centroids) {
            const distSq = (red - centroid[0]) ** 2
                + (green - centroid[1]) ** 2
                + (blue - centroid[2]) ** 2;
            if (distSq < minDistSq) {
                minDistSq = distSq;
                nearest = centroid;
            }
        }
        data[i] = nearest[0];
        data[i + 1] = nearest[1];
        data[i + 2] = nearest[2];
    }

    return data;
}
