import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { smoothstep } from './math';

/**
 * terrainColor — per-vertex terrain colour, baked into the mesh's `color`
 * attribute at build time rather than sampled from a texture.
 *
 * This is the primary reskin hook (ARCHITECTURE.md §8): a whole new biome is a
 * palette swap with zero geometry change, and it costs no texture bytes, which
 * matters against a 2MB single-file budget.
 *
 * PLACEHOLDER banding — height and slope only. Phase 7 replaces it with the
 * richer grass/dirt/rock/sand/snow ramp ported from
 * `Procedural_3D_world/src/terrain/terrainColor.js`.
 *
 * Writes into `out` (an {r,g,b} in 0..1) instead of returning a THREE.Color, for
 * the same no-allocation-per-vertex reason as `normalAt`.
 */

/**
 * Palette constants, unpacked once at module load.
 *
 * These go through THREE.Color rather than a hand-rolled `/255`, because
 * THREE.Color applies the sRGB→linear conversion for the renderer's colour
 * management while a raw byte divide does not. Vertex-colour attributes are
 * consumed as-is (assumed already linear), so hand-unpacking here would make
 * the terrain read noticeably washed-out next to the road ribbon, which does
 * use THREE.Color. Per-vertex interpolation below stays plain arithmetic — the
 * allocation-free part is the hot loop, not these four constants.
 */
const GRASS_LOW = new THREE.Color(0x5b8a4c);
const GRASS_HIGH = new THREE.Color(0x7aa85e);
const DIRT = new THREE.Color(0x7a6647);
/**
 * Rock is deliberately a cool blue-grey rather than the warm neutral it started
 * as (0x8d8880). Against the brown of DIRT — which saturates on the same steep
 * faces rock does, and is applied first — a warm grey differed mostly in
 * saturation, so even at a full blend it read as "slightly washed-out dirt"
 * rather than as stone. Hue separation is what makes the band legible.
 */
const ROCK = new THREE.Color(0x83888f);

/** High-contrast band colours for `debug.showSlopeBands`. */
const DEBUG_GRASS = new THREE.Color(0x0033ff);
const DEBUG_DIRT = new THREE.Color(0x00ff33);
const DEBUG_ROCK = new THREE.Color(0xff2200);

/**
 * Slope thresholds, converted once from the config's intuitive rise-over-run
 * values into the `normalY` the caller already has.
 *
 * A surface with slope `m` has `normalY = 1 / sqrt(1 + m²)`, and normalY falls
 * as slope rises — hence the inverted argument order in the smoothsteps below.
 * Doing the conversion here, once, keeps the config in units a human can set
 * ("dirt starts at a 0.14 grade") instead of normal components nobody can
 * picture, and keeps the per-vertex path to plain arithmetic.
 */
function slopeToNormalY(slope: number): number {
    return 1 / Math.sqrt(1 + slope * slope);
}

const DIRT_START_NY = slopeToNormalY(cfg.terrain.dirtSlopeStart);
const DIRT_FULL_NY = slopeToNormalY(cfg.terrain.dirtSlopeFull);
const ROCK_START_NY = slopeToNormalY(cfg.terrain.rockSlopeStart);
const ROCK_FULL_NY = slopeToNormalY(cfg.terrain.rockSlopeFull);

export function terrainColorAt(
    _x: number,
    y: number,
    _z: number,
    normalY: number,
    out: { r: number; g: number; b: number },
): void {
    const dirtT = smoothstep(DIRT_START_NY, DIRT_FULL_NY, normalY);
    const rockT = smoothstep(ROCK_START_NY, ROCK_FULL_NY, normalY);

    if (cfg.debug.showSlopeBands) {
        const base = rockT > 0.5 ? DEBUG_ROCK : dirtT > 0.5 ? DEBUG_DIRT : DEBUG_GRASS;
        out.r = base.r; out.g = base.g; out.b = base.b;
        return;
    }

    // Height ramp: darker green in the hollows, lighter on the rises.
    const amp = cfg.terrain.amplitude;
    const heightT = smoothstep(-amp, amp, y);
    let r = GRASS_LOW.r + (GRASS_HIGH.r - GRASS_LOW.r) * heightT;
    let g = GRASS_LOW.g + (GRASS_HIGH.g - GRASS_LOW.g) * heightT;
    let b = GRASS_LOW.b + (GRASS_HIGH.b - GRASS_LOW.b) * heightT;

    // Slope ramps: grass → dirt → bare rock as the ground steepens.
    r += (DIRT.r - r) * dirtT;
    g += (DIRT.g - g) * dirtT;
    b += (DIRT.b - b) * dirtT;

    out.r = r + (ROCK.r - r) * rockT;
    out.g = g + (ROCK.g - g) * rockT;
    out.b = b + (ROCK.b - b) * rockT;
}
