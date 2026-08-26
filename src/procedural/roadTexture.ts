import * as THREE from 'three';

/**
 * roadTexture — a tileable asphalt grain, baked on the CPU at boot.
 *
 * Costs no bundle bytes, which is the whole reason it is generated rather than
 * shipped: a 2MB budget cannot spare a road texture, and the alternative was a
 * flat vertex colour that read as painted card.
 *
 * ## Calibrated against res/road_texture.png, because the first pass was wrong
 *
 * Measured on the reference (asphalt region only, painted line excluded):
 *
 * ```
 *   mean luminance   99.3
 *   std deviation     5.24   <- the number that matters
 *   |dL| per px       2.37 horizontal, 2.28 vertical
 *   mean rgb          104, 98, 95   (very slightly warm)
 * ```
 *
 * Two things follow, and the first version got both backwards:
 *
 *  - **It is very LOW contrast.** sd 5.24 out of 255 is a ~5% modulation. The
 *    first pass clamped to [0.45, 1.0] — a 115/255 span, twenty times too much —
 *    which is why it read as noise painted onto the road rather than as asphalt.
 *  - **It is near-ISOTROPIC.** The horizontal and vertical gradients differ by
 *    4%, so there is essentially no directional streaking. The first pass
 *    stretched the noise 4:1 along the road on the theory that it would stand in
 *    for motion blur. That was a guess, and the reference does not support it;
 *    a faint 2:1 component is all that is left of the idea.
 *
 * The gradient-to-sd ratio (~0.45) says the variation is high FREQUENCY — fine
 * aggregate, not blotches — so the octaves sit at 2 and 4 pixels per lattice
 * cell rather than the coarse patchwork used before.
 *
 * ## Why it must tile in BOTH axes
 *
 * `RoadMesh` recycles a fixed pool of 20m bands and its UVs are LOCAL to a band,
 * so every band carries identical UVs. If the texture did not wrap seamlessly,
 * every band boundary would draw a hard line across the road every 20 metres.
 * The lattice period is therefore an integer in both axes, which is what makes
 * the value noise below periodic.
 */

/**
 * Value noise on a WRAPPING integer lattice, which is what makes it tileable.
 * Separate periods per axis so the grain can be stretched along the road.
 */
function tileableNoise(u: number, v: number, periodX: number, periodY: number, seed: number): number {
    const x = u * periodX, y = v * periodY;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const smooth = (t: number) => t * t * (3 - 2 * t);

    const at = (i: number, j: number) => {
        // Wrap into the lattice so the last cell interpolates back to the first.
        const wx = ((i % periodX) + periodX) % periodX;
        const wy = ((j % periodY) + periodY) % periodY;
        let h = wx * 374761393 + wy * 668265263 + seed * 1274126177;
        h = (h ^ (h >>> 13)) * 1274126177;
        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };

    const sx = smooth(fx), sy = smooth(fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/**
 * Greyscale, averaging near white.
 *
 * It MODULATES rather than colours: the material keeps `vertexColors`, which is
 * what distinguishes the asphalt strip from the two edge lines, so this texture
 * multiplies against whichever of those a pixel belongs to. A texture averaging
 * much below 1 would darken the road and the lines rather than texture them.
 */
export interface RoadTexture {
    texture: THREE.CanvasTexture;
    /**
     * Multiply the material's colour by this to undo the texture's average
     * darkening.
     *
     * The texture can only darken — see the note on clipping below — so its mean
     * sits under 1 and would dim the whole road. This is measured during
     * generation rather than hardcoded, so it cannot drift out of sync when
     * `grain` is retuned.
     */
    levelScale: number;
}

export function createRoadTexture(size: number, grain: number, streak: number): RoadTexture {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    const data = image.data;

    // ONE-SIDED: the texture only ever darkens, so its maximum is exactly 1 and
    // nothing clips. Centring the modulation on 1 instead — the obvious thing,
    // and what the previous version did — puts half of every distribution above
    // 255 in an 8-bit texture, so HALF the variation is silently thrown away and
    // the measured contrast comes out at a fraction of what was asked for.
    // The average darkening is handed back as `levelScale` and undone by the
    // material's colour.
    let sum = 0;
    for (let py = 0; py < size; py++) {
        const v = py / size;
        for (let px = 0; px < size; px++) {
            const u = px / size;

            // Two fine isotropic octaves — aggregate, not blotches. The
            // frequency is what the reference's gradient-to-sd ratio pins down:
            // 0.44 here against its 0.45.
            const fine = tileableNoise(u, v, 32, 32, 77);
            const grit = tileableNoise(u, v, 64, 64, 131);
            // All that is left of the streaking idea — a faint 2:1 stretch.
            const streaks = tileableNoise(u, v, 32, 16, 11);

            const n = (1 - streak) * (0.65 * fine + 0.35 * grit) + streak * streaks;
            const c = Math.round((1 - grain * (1 - n)) * 255);

            sum += c;
            const i = (py * size + px) * 4;
            data[i] = c; data[i + 1] = c; data[i + 2] = c; data[i + 3] = 255;
        }
    }
    const levelScale = 255 / (sum / (size * size));
    ctx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    // A canvas holds sRGB bytes and Texture defaults to NoColorSpace, so without
    // this the decode is skipped and the grain renders far too bright and flat.
    // See ARCHITECTURE.md gotcha 15.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // The road is seen at a grazing angle for most of its length, which is
    // exactly the case trilinear filtering blurs to mush. Anisotropy is the one
    // knob that fixes it, and it is cheap next to any other option.
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return { texture, levelScale };
}
