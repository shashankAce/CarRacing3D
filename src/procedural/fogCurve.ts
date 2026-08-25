import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';

/**
 * fogCurve — replaces the exponent in three.js's FogExp2 term.
 *
 * ## Why
 *
 * `FogExp2` is `1 - exp(-(density * depth)²)`, one parameter, and its SHAPE is
 * wrong for an infinite scroller. Two things have to be true at once:
 *
 *  - the near field keeps its colour, or the world looks washed out (this is
 *    what made the rock band look like it was never being generated), and
 *  - the terrain streaming edge at 240-280m is fully hidden, or a new chunk row
 *    arriving reads as the world being built ahead of you.
 *
 * At exponent 2 those are locked together, because the curve starts rising
 * immediately and saturates slowly. To get 0.5% residual at 240m you need
 * density 0.0096 — which leaves only 27% of a surface's own colour at 120m and
 * 55% at 80m. That is precisely the 0.010 setting that was tried and rejected
 * for washing everything pale. There is no density that satisfies both.
 *
 * A higher exponent unlocks them, because it delays the onset and then saturates
 * hard. Same 0.5% residual at the draw edge, and:
 *
 * ```
 *   distance    exponent 2 @ 0.0096    exponent 4 @ 0.0063
 *   ------------------------------------------------------
 *      60m         72% own colour          98%
 *      80m         55%                     94%
 *     120m         27%                     72%
 *     180m          8%                      19%
 *     240m        0.5%                     0.5%
 *     280m       0.03%                   0.006%
 * ```
 *
 * 2.7x more colour retained at 120m for identical occlusion where it matters.
 *
 * ## What it is honestly
 *
 * Not physics. A homogeneous participating medium integrates to exp(-σd) —
 * exponent 1. Exponent 2 is already stylised; 4 is more so, and corresponds to a
 * medium that gets DENSER with distance, which is nonsense as a world model and
 * perfectly reasonable as an art curve. It is the cheapest possible way to buy
 * the occlusion: one extra `pow` on fragments that already run a full material,
 * no draw calls, no overdraw, no texture. The alternatives measured or estimated
 * far worse — a stack of translucent slabs cost ~2x fullscreen of blending, and
 * a real raymarched volumetric needs the depth buffer plus a per-pixel march
 * (the sky's old noise shader, a comparable workload over less of the screen,
 * measured 14ms on a low-end phone).
 *
 * ## The other half of the trick
 *
 * Fog only blends a surface TOWARD the fog colour; it cannot hide anything
 * unless the background behind it is that colour too. The sky's ramp is what
 * supplies that — see `sky.horizonHold`. Change one, check the other.
 *
 * ## Caveats
 *
 *  - This edits `THREE.ShaderChunk`, which is GLOBAL: every fogged material
 *    picks it up (terrain, road, trees, impostors, traffic). That is the point —
 *    one consistent atmosphere — but it is global surgery, so it lives in its
 *    own module with this comment rather than buried in a scene.
 *  - The exponent compiles in as a literal, so changing `world.fogFalloff` needs
 *    a reload, not a hot-swap.
 *  - Must run before the first frame. Shader programs are built lazily at first
 *    render, so it is enough to call this before `engine.start()`.
 *  - Linear `Fog` is left completely alone; only the FOG_EXP2 branch changes.
 */

/** The exact line three.js ships. Matched verbatim so a version bump fails loudly. */
const FOG_EXP2_LINE =
    'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );';

export function installFogCurve(): void {
    const falloff = cfg.world.fogFalloff;

    // Exponent 2 IS what three.js already does — (density*depth)² either way.
    if (falloff === 2) return;

    const chunk = THREE.ShaderChunk.fog_fragment;
    if (!chunk.includes(FOG_EXP2_LINE)) {
        // Better a physically-standard fog than a broken shader: bail loudly and
        // let the stock term stand.
        console.warn(
            '[fogCurve] three.js fog_fragment no longer matches the expected ' +
            'FogExp2 line; leaving it unpatched. Re-check against the installed ' +
            'three version.',
        );
        return;
    }

    // `fogDensity * vFogDepth` is never negative (density is positive, depth is
    // a distance), so pow() is always well-defined here, and pow(0.0, n) is 0.
    THREE.ShaderChunk.fog_fragment = chunk.replace(
        FOG_EXP2_LINE,
        `float fogFactor = 1.0 - exp( - pow( fogDensity * vFogDepth, ${falloff.toFixed(1)} ) );`,
    );
}
