import { gameConfig as cfg } from '../config/gameConfig';

/**
 * roadPath — the road's centreline, as a pure function of absolute world Z.
 *
 * This mirrors `Procedural_3D_world`'s `riverPathX(z)` exactly, and for the
 * same reason: everything that needs to know where the road is — the terrain
 * height field's corridor carve, the asphalt ribbon, the lane markers, the
 * roadside posts, and (Phase 4) traffic lane positions — reads this one
 * function. They cannot drift out of alignment, and turning a dead-straight
 * road into a curving one is a config change rather than a rewrite. See
 * ARCHITECTURE.md §5.2.
 */

/**
 * Lateral centre of the road at absolute world Z.
 *
 * NOTE ON FREQUENCY: a wavelength is 2π/frequency, and it has to be comfortably
 * SHORTER than the visible road (`terrain.chunkLength * terrain.chunksAhead`) or
 * the bend can't be perceived — you see a fraction of one wave, which reads as
 * a dead-straight road drifting sideways. At 0.004 the wavelength was 1571m
 * against ~200m of visible road, and it looked perfectly straight.
 */
export function roadCenterX(worldZ: number): number {
    const amp = cfg.road.curveAmplitude;
    if (amp === 0) return 0;   // the common case — skip the trig entirely
    // Two incommensurable frequencies, so the sway never reads as a repeating
    // sine wave however long the run goes on.
    const f = cfg.road.curveFrequency;
    return amp * (
        Math.sin(worldZ * f) * 0.7 +
        Math.sin(worldZ * f * 2.3 + 1.7) * 0.3
    );
}

/**
 * Surface height of the road at absolute world Z — the road's crests and dips.
 *
 * The sibling of `roadCenterX`, and used the same way: it is the ONE definition
 * of road elevation, read by the terrain height field (which flattens the
 * corridor to exactly this), the asphalt ribbon, the centre-line dashes, and
 * the car's own Y. Long wavelengths on purpose — a road that undulates as fast
 * as the terrain does reads as a rollercoaster, not a highway.
 */
export function roadLevelAt(worldZ: number): number {
    const amp = cfg.road.slopeAmplitude;
    if (amp === 0) return cfg.road.level;
    const f = cfg.road.slopeFrequency;
    return cfg.road.level + amp * (
        Math.sin(worldZ * f) * 0.65 +
        Math.sin(worldZ * f * 1.9 + 0.9) * 0.35
    );
}

/**
 * Yaw (rotation about +Y) that aligns an object with the road's heading at
 * `worldZ`. Anything longer than it is wide needs this on a curving road — the
 * road's direction rotates, and an axis-aligned box laid along it cuts the
 * corner, reading as a straight chord kinked across a bending lane.
 *
 * Measured by central difference rather than by differentiating the formula, so
 * it stays correct if `roadCenterX` is ever reshaped.
 */
export function roadHeadingAt(worldZ: number): number {
    if (cfg.road.curveAmplitude === 0) return 0;
    const eps = 1;
    const dx = roadCenterX(worldZ + eps) - roadCenterX(worldZ - eps);
    // Rotating about +Y turns the forward axis (-Z) toward -X, so a road
    // bending toward +X needs a negative yaw.
    return -Math.atan2(dx, 2 * eps);
}

/**
 * Pitch (rotation about +X) for a rigid body of length `length` sitting on the
 * road at `worldZ`, from the road height under its front and rear.
 *
 * Sampling the footprint rather than differentiating is deliberate: it's the
 * behaviour a rigid body actually has — bridging a crest, touching near its
 * middle — and it stays correct for any length. Without it, a body's ends sink
 * into or float above the road on any grade.
 */
export function roadPitchAt(worldZ: number, length: number): number {
    if (cfg.road.slopeAmplitude === 0) return 0;
    const half = length / 2;
    return Math.atan2(roadLevelAt(worldZ + half) - roadLevelAt(worldZ - half), length);
}

/** Signed lateral distance from the road centre. Negative = left of centre. */
export function offsetFromRoadCenter(x: number, worldZ: number): number {
    return x - roadCenterX(worldZ);
}
