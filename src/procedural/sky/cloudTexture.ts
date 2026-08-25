import * as THREE from 'three';

/**
 * A single soft cloud puff, generated once on the CPU at boot, used as the map
 * for every cloud sprite.
 *
 * This replaces per-pixel cloud noise in the sky shader, which measured ~7.7ms a
 * frame — roughly 14ms on a low-end phone, a third of a 42ms regression —
 * because every cloud pixel ran about 16 evaluations of 3D simplex. A handful of
 * sprites pay only for the pixels they actually cover, and one texture fetch
 * each.
 *
 * Generated rather than shipped, so it costs nothing against a 2MB budget, and
 * baking can afford more octaves than a realtime shader ever could.
 */

/** Deterministic lattice hash → 0..1. */
function latticeValue(ix: number, iy: number, seed: number): number {
    let h = Math.imul(ix, 0x1f1f1f1f) ^ Math.imul(iy, 0x2545f491) ^ Math.imul(seed, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
    return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = fade(x - ix), fy = fade(y - iy);
    const a = latticeValue(ix, iy, seed);
    const b = latticeValue(ix + 1, iy, seed);
    const c = latticeValue(ix, iy + 1, seed);
    const d = latticeValue(ix + 1, iy + 1, seed);
    const top = a + (b - a) * fx;
    const bottom = c + (d - c) * fx;
    return top + (bottom - top) * fy;
}

/**
 * @param size Texture edge in pixels.
 * @param seed Varies the puff's shape between variants.
 */
export function createCloudSpriteTexture(size: number, seed: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    const data = image.data;

    const octaves = [3, 6, 12, 24];
    const amps = [0.5, 0.26, 0.14, 0.1];
    const total = amps.reduce((a, b) => a + b, 0);

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const u = px / (size - 1);
            const v = py / (size - 1);

            // Radial falloff, squashed vertically so a puff is wider than tall.
            const dx = (u - 0.5) * 2;
            const dy = (v - 0.5) * 2 * 1.7;
            const r = Math.sqrt(dx * dx + dy * dy);
            const disc = 1 - fade(Math.min(1, Math.max(0, (r - 0.25) / 0.75)));

            let n = 0;
            for (let o = 0; o < octaves.length; o++) {
                n += amps[o] * valueNoise(u * octaves[o], v * octaves[o], seed + o * 71);
            }
            n /= total;

            // Noise breaks up the silhouette; the disc guarantees the edges reach
            // zero so sprites never show a hard rectangular boundary.
            let alpha = disc * Math.max(0, n * 1.55 - 0.42);
            alpha = Math.min(1, alpha * 2.1);

            // Denser centres read as brighter, lit tops; thin edges stay grey.
            const shade = 0.82 + 0.18 * Math.min(1, n * 1.4);
            const i = (py * size + px) * 4;
            const c = Math.round(255 * shade);
            data[i] = c; data[i + 1] = c; data[i + 2] = Math.round(255 * Math.min(1, shade * 1.02));
            data[i + 3] = Math.round(alpha * 255);
        }
    }
    ctx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    // MANDATORY for any texture holding COLOUR. A canvas stores sRGB bytes, but
    // Texture.colorSpace defaults to NoColorSpace, so without this the shader
    // skips the sRGB -> linear decode and uses the encoded bytes as if they were
    // linear -- rendering the texture far too bright and, worse, FLAT.
    //
    // Measured here: the authored shading runs 0.82 -> 1.0 (bytes 209 -> 255).
    // Undecoded it rendered as 234 -> 255, compressing the puff's internal
    // contrast by 2.4x, which is a large part of why the clouds read as washed
    // out. Same class of bug as SkyDome's missing colorspace_fragment; see
    // ARCHITECTURE.md gotcha 15.
    //
    // Alpha is never colour-managed, so only the RGB shading was affected.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}
