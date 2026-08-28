import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';
import { activeEnvironmentBlend, environmentSkyPreset } from '../../config/environment';

/**
 * skyModel — the dome's shading, on the CPU.
 *
 * This is a deliberate mirror of `SkyDome`'s fragment shader, and the two must
 * stay in step. That is enforced the only way it can be: every constant either
 * lives in `gameConfig` and is read by BOTH, or is interpolated into the GLSL
 * from here. Nothing is written twice.
 *
 * ## Why the CPU needs it at all
 *
 * The fog colour. Fog can only HIDE something when the sky behind it is the same
 * colour, so the fog has to be whatever the sky actually is where distant
 * geometry meets it. That used to be approximated as "the horizon colour", which
 * held only while the sun was far from the view axis. Put the sun in frame and
 * the sky ahead is dominated by its glow — measured at rgb(255,255,221) dead
 * centre against a fog of rgb(239,143,82), a ~100/255 mismatch across the whole
 * middle of the screen. That is what "the fog stopped working" looks like.
 *
 * Deriving it instead means the fog tracks `timeOfDay.sunsetOffsetDegrees`, the
 * hour, and the moon at night, with nothing to re-tune by hand.
 *
 * ## Why an average and not a single direction
 *
 * The fog is ONE colour and the sky is a gradient, so it cannot match everywhere.
 * Matching the exact forward direction is perfect dead-centre and worst at the
 * frame edges; averaging over the visible arc halves the worst case instead. That
 * is the best a single colour can do — the alternative is per-pixel atmospheric
 * scattering, which is a fullscreen pass this project cannot afford.
 */

/** Direction from an engine azimuth and elevation, both degrees. 180 is forward. */
function direction(azimuthDeg: number, elevationDeg: number): [number, number, number] {
    const az = azimuthDeg * Math.PI / 180;
    const el = elevationDeg * Math.PI / 180;
    const cosEl = Math.cos(el);
    return [Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl];
}

const smoothstep = (edge: number, x: number) => {
    const t = Math.max(0, Math.min(1, x / edge));
    return t * t * (3 - 2 * t);
};
const smoothrange = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};
const norm = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};

// Reused palette colours: fog derivation evaluates the model dozens of times,
// so allocating several THREE.Color objects per sample would create avoidable
// garbage throughout every biome transition.
const _horizonLow = new THREE.Color();
const _horizonHigh = new THREE.Color();
const _zenithLow = new THREE.Color();
const _zenithHigh = new THREE.Color();
const _glow = new THREE.Color();
const _paletteScratch = new THREE.Color();
const _moonColor = new THREE.Color();

function blendPaletteColor(
    out: THREE.Color,
    forest: number,
    desert: number,
    blend: number,
): THREE.Color {
    return out.set(forest).lerp(_paletteScratch.set(desert), blend);
}

/**
 * Sky colour for a direction, in LINEAR space, matching the dome's shader term
 * for term. Clamped per channel because the framebuffer clamps too — an
 * unclamped average would be pulled around by glow values the screen never
 * actually shows.
 */
export function skyColorAt(
    dir: [number, number, number],
    out: THREE.Color = new THREE.Color(),
    environmentBlend = activeEnvironmentBlend(),
): THREE.Color {
    const s = cfg.sky;
    const forest = environmentSkyPreset('forest');
    const desert = environmentSkyPreset('desert');
    const d = norm(dir);
    const day = Math.max(0, Math.min(1, s.dayFactor));

    blendPaletteColor(_horizonLow, forest.horizonLow, desert.horizonLow, environmentBlend);
    blendPaletteColor(_horizonHigh, forest.horizon, desert.horizon, environmentBlend);
    blendPaletteColor(_zenithLow, forest.zenithLow, desert.zenithLow, environmentBlend);
    blendPaletteColor(_zenithHigh, forest.zenith, desert.zenith, environmentBlend);
    const horizon = _horizonLow.lerp(_horizonHigh, day);
    const zenith = _zenithLow.lerp(_zenithHigh, day);

    const t = Math.pow(smoothstep(s.skyTopHeight, Math.max(d[1], 0)), s.horizonHold);
    out.copy(horizon).lerp(zenith, t);

    const sun = norm([s.sunDirection.x, s.sunDirection.y, s.sunDirection.z]);
    const sunUp = smoothrange(-0.07, 0.02, sun[1]);
    const sunDot = Math.max(0, d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]);
    const g = s.sunGlow;
    const sunTerm = sunUp * (Math.pow(sunDot, g.broadExp) * g.broadAmp
        + Math.pow(sunDot, g.tightExp) * g.tightAmp);

    const moon = norm([s.moonDirection.x, s.moonDirection.y, s.moonDirection.z]);
    const moonUp = smoothrange(-0.02, 0.05, moon[1]);
    const moonDot = Math.max(0, d[0] * moon[0] + d[1] * moon[1] + d[2] * moon[2]);
    const m = s.moonGlow;
    const moonTerm = moonUp * smoothrange(m.discOuterDot, m.discInnerDot, moonDot) * m.discAmp;

    blendPaletteColor(_glow, forest.glow, desert.glow, environmentBlend);
    _moonColor.set(cfg.lighting.moonColor);
    out.r = Math.min(1, out.r + _glow.r * sunTerm + _moonColor.r * moonTerm);
    out.g = Math.min(1, out.g + _glow.g * sunTerm + _moonColor.g * moonTerm);
    out.b = Math.min(1, out.b + _glow.b * sunTerm + _moonColor.b * moonTerm);
    return out;
}

/**
 * The fog colour: the sky averaged over the band where distant geometry actually
 * meets it — the forward arc, from just below the horizon to a few degrees above,
 * which is where the terrain draw edge and the tree line sit.
 */
export function deriveFogColor(environmentBlend = activeEnvironmentBlend()): THREE.Color {
    const arc = cfg.sky.fogSampleArcDegrees;
    const scratch = new THREE.Color();
    let r = 0, g = 0, b = 0, n = 0;
    for (let a = -arc; a <= arc + 1e-6; a += arc / 8) {
        for (const el of [-1, 0, 1, 2, 3]) {
            skyColorAt(direction(180 + a, el), scratch, environmentBlend);
            r += scratch.r; g += scratch.g; b += scratch.b; n++;
        }
    }
    return new THREE.Color().setRGB(r / n, g / n, b / n);
}
