import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadLevelAt } from '../world/roadPath';
import { smoothstep, lerp } from './math';

/**
 * heightField — the terrain surface, as a pure function of absolute world (x, z).
 *
 * The purity is the whole point, and it's what makes infinite streaming work:
 * a chunk can be built, destroyed, and rebuilt at any grid coordinate in any
 * order and it always stitches perfectly to its neighbours, because a vertex's
 * height and normal depend only on where it is in the world — never on which
 * chunk it happens to belong to, or what was built before it.
 *
 * Structure is ported from `Procedural_3D_world/src/terrain/heightField.js`,
 * with its river channel replaced by the road corridor: flat at road level
 * inside `road.halfWidth`, then eased up to ambient terrain over
 * `road.shoulderWidth`. Same guarantee as the original's riverbank — the ground
 * is flush with the road surface by construction right at its edge, regardless
 * of what the ambient field happens to be doing further out, so terrain can
 * never poke through the asphalt.
 */

/**
 * One octave of smooth, non-repeating-looking undulation. Two incommensurable
 * terms so a single octave doesn't read as a regular grid of bumps.
 */
function octave(u: number, v: number): number {
    return Math.sin(u) * Math.cos(v * 0.83) + 0.4 * Math.sin((u + v) * 1.7);
}

/**
 * Spacing between terrain vertices — the chunk grid's resolution in metres.
 */
const VERTEX_SPACING = cfg.terrain.chunkSize / (cfg.terrain.resolution - 1);

/**
 * How far past the visible asphalt the terrain stays perfectly flat.
 *
 * This is not cosmetic padding, it's a correctness requirement. The terrain is
 * a triangle mesh sampled on a `VERTEX_SPACING` grid, and the road ribbon is a
 * separate flat strip only `road.halfWidth` wide. If the shoulder starts rising
 * exactly at `halfWidth`, a triangle can have one vertex inside the corridor at
 * road level and the next one already lifted, and linear interpolation across
 * that triangle carries the terrain OVER the road edge — measured at up to 84cm
 * above the asphalt, which reads as the ground swallowing the road in a
 * staircase stepped at the grid spacing.
 *
 * Holding the corridor flat for more than one full vertex spacing guarantees
 * both ends of any triangle crossing the road edge are at road level, so it
 * can't tilt. Derived from the grid rather than hardcoded, so it stays correct
 * if `chunkSize` or `resolution` change.
 */
const FLAT_MARGIN = VERTEX_SPACING * 1.5;

/** Half-width of the flattened corridor, i.e. the asphalt plus that margin. */
const CORRIDOR_HALF_WIDTH = cfg.road.halfWidth + FLAT_MARGIN;

/**
 * Rolling hills away from the road.
 *
 * PLACEHOLDER — cheap trigonometry, not noise. But it IS multi-octave, because
 * a single low-frequency octave has no local steepness: its slope is
 * amplitude × frequency, which for hills big enough to see is far too gentle to
 * ever expose the dirt and rock colour bands. The small high-frequency octave
 * is what actually creates slope, and therefore what makes the terrain read as
 * ground rather than as a tinted plane.
 *
 * Phase 5 replaces this body with the ported fbm + ridged-mountain field from
 * `Procedural_3D_world/src/terrain/ambientHeight.js`. Nothing else in this file
 * changes when it does — this function is the only seam.
 */
export function ambientHeightAt(x: number, z: number): number {
    const f = cfg.terrain.baseFrequency;
    const a = cfg.terrain.amplitude;
    // Per-octave offsets keep the octaves from lining up their peaks at the origin.
    return a * (
        0.55 * octave(x * f, z * f) +
        0.30 * octave(x * f * 2.4 + 11.3, z * f * 2.4 + 7.1) +
        0.15 * octave(x * f * 5.8 + 23.7, z * f * 5.8 + 17.9)
    );
}

/**
 * The road terms of the height field at one Z — everything that does NOT vary
 * with x. Hoisting these out of a scan along x saves four trig calls per sample,
 * which is why the chunk builder samples row by row.
 */
export interface HeightRow {
    centreX: number;
    level: number;
}

/** Fills `out` with the road terms at absolute world Z. */
export function heightRowAt(z: number, out: HeightRow): void {
    out.centreX = roadCenterX(z);
    out.level = roadLevelAt(z);
}

/**
 * Terrain height, given the road terms for this Z already computed. The single
 * definition of the surface — `heightAt` is a convenience wrapper over it, so
 * there is no second copy of this logic to drift out of sync.
 */
export function heightInRow(x: number, z: number, row: HeightRow): number {
    const distToCenter = Math.abs(x - row.centreX);

    // Inside the corridor the surface is exactly flat. Not "nearly flat" — the
    // car's own Y and the collision maths both assume a level road. The corridor
    // is wider than the asphalt by FLAT_MARGIN; see that constant for why.
    if (distToCenter <= CORRIDOR_HALF_WIDTH) return row.level;

    // Shoulder: ease from the road's own level out to ambient. Anchoring to the
    // road level (rather than blending ambient against ambient) is what
    // guarantees flush contact at the edge.
    const t = smoothstep(0, cfg.road.shoulderWidth, distToCenter - CORRIDOR_HALF_WIDTH);
    return lerp(row.level, ambientHeightAt(x, z), t);
}

/** Scratch row for `heightAt`. Single-threaded and never nested, so it's safe. */
const _row: HeightRow = { centreX: 0, level: 0 };

/**
 * Terrain height at an absolute world position.
 *
 * The corridor is flattened to the ROAD's elevation at this z, not to a
 * constant — so the terrain follows the road over crests and through dips and
 * the two can never separate.
 */
export function heightAt(x: number, z: number): number {
    heightRowAt(z, _row);
    return heightInRow(x, z, _row);
}

/**
 * Height of the DRIVABLE surface at an absolute world position — what a vehicle
 * actually rests on, as opposed to what the terrain mesh is.
 *
 * These differ by `roadSurface.lift`. The asphalt ribbon is drawn that far above
 * the terrain corridor because two coplanar surfaces z-fight, which makes the
 * lift a real 2cm layer of road sitting on the ground. A vehicle placed with
 * `heightAt` therefore sits 2cm INSIDE the visible road — a constant sink that
 * reads, from a chase camera, as the body's underside cutting into the asphalt
 * (most obviously at the rear, which is the part of the underside you can see).
 *
 * Anything that drives — the player, and Phase 4's traffic — must use this
 * rather than `heightAt`.
 */
export function surfaceHeightAt(x: number, z: number): number {
    const distToCenter = Math.abs(x - roadCenterX(z));
    if (distToCenter <= cfg.road.halfWidth) return roadLevelAt(z) + cfg.roadSurface.lift;
    return heightAt(x, z);
}

/**
 * Analytic surface normal in WORLD space, from the height field's gradient by
 * central difference. Written into `out` rather than returned as a new vector,
 * to avoid a throwaway object per call.
 *
 * **The z component is world-space and must be NEGATED for a chunk mesh's local
 * frame.** A chunk mirrors Z (its local z runs 0 → -size, because forward is
 * -Z), and mirroring an axis flips the corresponding normal component: local
 * z is `+∂h/∂Z` where world z is `-∂h/∂Z`. Getting this wrong mis-shades slopes
 * along the travel axis — measured at up to ~37° of normal error on the steepest
 * faces — and it doesn't show up in the colour bands, which only read
 * `normal.y`, so it hides well. It was wrong for exactly that reason until the
 * grid-normal rewrite.
 *
 * `chunkMesh` no longer uses this — it derives normals from the heights it has
 * already sampled, at ~1 field evaluation per vertex instead of 5. This is kept
 * for callers that need a normal at an arbitrary point (aligning scattered
 * objects to the ground, for instance).
 */
export function normalAt(x: number, z: number, out: { x: number; y: number; z: number }, eps = 0.4): void {
    const hL = heightAt(x - eps, z), hR = heightAt(x + eps, z);
    const hD = heightAt(x, z - eps), hU = heightAt(x, z + eps);
    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);
    // Normalise (-dx, 1, -dz).
    const len = Math.sqrt(dx * dx + 1 + dz * dz);
    out.x = -dx / len;
    out.y = 1 / len;
    out.z = -dz / len;
}
