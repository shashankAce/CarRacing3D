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
// Saturated deliberately: a palette that looks correct up close reads as grey at
// mid-distance, so the terrain has to start more vivid than it should look.
//
// CALIBRATED AGAINST THE OLD FOG, which removed 39% of the colour by 100m.
// `world.fogFalloff` now removes only 15% there, so this palette over-delivers —
// if the near field reads garish rather than vivid, desaturate HERE rather than
// thickening the fog, which is doing a different job (see fogCurve.ts).
// Olive rather than green, matched to res/gameplay_ref.jpg the same way as the
// foliage: reference hue and saturation, our lightness. Sampled grass there is
// rgb(169,166,77) lit and rgb(141,137,80) mid — red and green within 4 of each
// other, i.e. khaki. Ours was rgb(136,196,85), green 60 above red.
const GRASS_LOW = new THREE.Color(0x87834d);
const GRASS_HIGH = new THREE.Color(0xb7b562);
// Pushed redder and darker because ROCK moved (see below): dirt and rock share
// the same steep faces, so they have to stay separated in HUE, and rock going
// warm would otherwise put them back on top of each other.
const DIRT = new THREE.Color(0x7a4f2a);
/**
 * Warm tan, from the reference's cliffs — sampled rgb(146,131,98) mid and
 * rgb(180,156,105) lit.
 *
 * This REVERSES an earlier decision, so the reasoning matters. Rock was moved
 * to a cool blue-grey (0x83888f) because against DIRT's brown — same steep
 * faces, applied first — a warm grey differed only in saturation and read as
 * "washed-out dirt" rather than stone. That problem is real and still applies;
 * the fix here is to keep the HUE SEPARATION but take it from the other side,
 * pushing DIRT redder and darker instead of pulling rock cool. Change one of
 * these two and check the other, or the band stops being legible.
 */
const ROCK = new THREE.Color(0xa09272);

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
    // Rock from steepness OR from altitude, whichever is stronger. Slope alone
    // is enough for hills, but a mountain has broad gentle flanks high up that
    // would otherwise stay bright grass — and a green mountain reads wrong when
    // the whole point of raising the terrain was to get rock.
    const rockT = Math.max(
        smoothstep(ROCK_START_NY, ROCK_FULL_NY, normalY),
        smoothstep(cfg.terrain.rockAltitudeStart, cfg.terrain.rockAltitudeFull, y),
    );

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
