/**
 * Seeded randomness for procedural placement.
 *
 * Determinism is the whole requirement: a terrain chunk is unloaded and rebuilt
 * whenever the player's window moves past it, and the trees on it must come back
 * identically. So nothing here may depend on call order or global state — every
 * value is a pure function of a seed derived from the chunk's own coordinates.
 */

/** `mulberry32` — ported from Procedural_3D_world's `src/utils/noise.js`. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Integer hash of a chunk coordinate pair, for seeding that chunk's RNG.
 * Signed inputs are folded into the unsigned range first, so a chunk at
 * cz = -3 doesn't collide with one at cz = 3.
 */
export function hashChunk(cx: number, cz: number, salt = 0): number {
    let h = (cx * 0x1f1f1f1f) ^ (cz * 0x2545f491) ^ (salt * 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (h ^ (h >>> 16)) >>> 0;
}
