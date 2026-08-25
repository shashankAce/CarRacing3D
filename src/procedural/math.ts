/**
 * Small math helpers shared by the procedural generators.
 * Ported from `Procedural_3D_world/src/utils/math.js`.
 */

/** Hermite smoothstep. Returns 0 below `edge0`, 1 above `edge1`, eased between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}
