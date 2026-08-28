import { gameConfig as cfg } from '../config/gameConfig';

/** Stable -1..1 wind-ripple signal shared by sand height and colour. */
export function sandWindPatternAt(x: number, z: number): number {
    const w = cfg.terrain.presets.desert.windPattern;
    if (!w.enabled) return 0;

    const length = Math.hypot(w.direction.x, w.direction.z) || 1;
    const dx = w.direction.x / length;
    const dz = w.direction.z / length;
    const across = x * dx + z * dz;
    const along = -x * dz + z * dx;
    const phase = across * w.frequency
        + Math.sin(along * w.warpFrequency) * w.warp;

    // A weak second harmonic sharpens the windward crest without making the
    // surface look like evenly spaced manufactured waves.
    return (Math.sin(phase) + Math.sin(phase * 2.03 + 0.8) * 0.32) / 1.32;
}
