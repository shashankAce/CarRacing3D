import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { activeEnvironment, environmentTerrainPreset } from '../config/environment';
import { smoothstep } from './math';
import { sandWindPatternAt } from './sandWind';

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
 * Palette constants, unpacked once at module load from `environments`.
 *
 * The values live on the config surface rather than here because the ground
 * colour is the most obviously reskinnable thing in the game; the tuning
 * couplings (dirt vs rock hue separation, and these being PRE-fog colours) are
 * documented at that site, where whoever changes them will actually read them.
 *
 * They go through THREE.Color rather than a hand-rolled `/255`, because
 * THREE.Color applies the sRGB→linear conversion for the renderer's colour
 * management while a raw byte divide does not. Vertex-colour attributes are
 * consumed as-is (assumed already linear), so hand-unpacking here would make
 * the terrain read noticeably washed-out next to the road ribbon, which does
 * use THREE.Color. Per-vertex interpolation below stays plain arithmetic — the
 * allocation-free part is the hot loop, not these four constants.
 */
const PALETTES = {
    forest: {
        low: new THREE.Color(cfg.environments.forest.terrain.low),
        high: new THREE.Color(cfg.environments.forest.terrain.high),
        dirt: new THREE.Color(cfg.environments.forest.terrain.dirt),
        rock: new THREE.Color(cfg.environments.forest.terrain.rock),
    },
    desert: {
        low: new THREE.Color(cfg.environments.desert.terrain.low),
        high: new THREE.Color(cfg.environments.desert.terrain.high),
        dirt: new THREE.Color(cfg.environments.desert.terrain.dirt),
        rock: new THREE.Color(cfg.environments.desert.terrain.rock),
    },
};

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

const SLOPE_THRESHOLDS = {
    forest: {
        dirtStart: slopeToNormalY(cfg.terrain.presets.forest.dirtSlopeStart),
        dirtFull: slopeToNormalY(cfg.terrain.presets.forest.dirtSlopeFull),
        rockStart: slopeToNormalY(cfg.terrain.presets.forest.rockSlopeStart),
        rockFull: slopeToNormalY(cfg.terrain.presets.forest.rockSlopeFull),
    },
    desert: {
        dirtStart: slopeToNormalY(cfg.terrain.presets.desert.dirtSlopeStart),
        dirtFull: slopeToNormalY(cfg.terrain.presets.desert.dirtSlopeFull),
        rockStart: slopeToNormalY(cfg.terrain.presets.desert.rockSlopeStart),
        rockFull: slopeToNormalY(cfg.terrain.presets.desert.rockSlopeFull),
    },
};

export function terrainColorAt(
    x: number,
    y: number,
    z: number,
    normalY: number,
    out: { r: number; g: number; b: number },
): void {
    const environment = activeEnvironment();
    const palette = PALETTES[environment];
    const slopes = SLOPE_THRESHOLDS[environment];
    const preset = environmentTerrainPreset(environment);
    const dirtT = smoothstep(slopes.dirtStart, slopes.dirtFull, normalY);
    // Rock from steepness OR from altitude, whichever is stronger. Slope alone
    // is enough for hills, but a mountain has broad gentle flanks high up that
    // would otherwise stay bright grass — and a green mountain reads wrong when
    // the whole point of raising the terrain was to get rock.
    const rockT = Math.max(
        smoothstep(slopes.rockStart, slopes.rockFull, normalY),
        smoothstep(preset.rockAltitudeStart, preset.rockAltitudeFull, y),
    );

    if (cfg.debug.showSlopeBands) {
        const base = rockT > 0.5 ? DEBUG_ROCK : dirtT > 0.5 ? DEBUG_DIRT : DEBUG_GRASS;
        out.r = base.r; out.g = base.g; out.b = base.b;
        return;
    }

    // Height ramp: darker green in the hollows, lighter on the rises.
    const amp = preset.amplitude;
    const heightT = smoothstep(-amp, amp, y);
    let r = palette.low.r + (palette.high.r - palette.low.r) * heightT;
    let g = palette.low.g + (palette.high.g - palette.low.g) * heightT;
    let b = palette.low.b + (palette.high.b - palette.low.b) * heightT;

    // Slope ramps: grass → dirt → bare rock as the ground steepens.
    r += (palette.dirt.r - r) * dirtT;
    g += (palette.dirt.g - g) * dirtT;
    b += (palette.dirt.b - b) * dirtT;

    out.r = r + (palette.rock.r - r) * rockT;
    out.g = g + (palette.rock.g - g) * rockT;
    out.b = b + (palette.rock.b - b) * rockT;

    if (environment === 'desert') {
        // Wind markings belong on sand, not on steep exposed faces. This also
        // keeps mountain silhouettes clean when their slope config is retuned.
        const flatT = smoothstep(0.86, 0.985, normalY) * (1 - rockT);
        const contrast = 1 + sandWindPatternAt(x, z)
            * cfg.terrain.presets.desert.windPattern.colorStrength * flatT;
        out.r *= contrast;
        out.g *= contrast;
        out.b *= contrast;
    }
}
