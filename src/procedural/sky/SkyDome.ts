import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';
import { environmentSkyPreset } from '../../config/environment';
import { deriveFogColor } from './skyModel';

/**
 * SkyDome — a large inverted sphere with an analytic gradient, a sun glow and a
 * horizon-flattening ramp.
 *
 * Ported from Procedural_3D_world's `src/sky/skyDome.js`, reduced to the
 * gradient and glow. Both of its cloud implementations are gone: the shader's
 * per-pixel noise field (measured at 7.7ms a frame, ~14ms on a low-end phone,
 * paid across the whole upper sky whether a cloud was there or not) and the
 * CPU-side mirror of it that dimmed sunlight behind clouds. Clouds are
 * billboards now — see `CloudSprites`.
 *
 * What remains is a handful of ALU per pixel, which measured as very nearly
 * free. That's why a procedural sky is the right call against a 2MB budget where
 * a cubemap would cost hundreds of kilobytes.
 *
 * Three properties make it sit correctly in this game:
 *
 *  - **`fog: false`.** The scene's FogExp2 would otherwise wash the dome toward
 *    the fog colour and flatten the gradient. Instead the scene's fog is DERIVED
 *    from this dome's own horizon (`effectiveHorizonColor`), so the two agree by
 *    construction at any sun angle rather than by a hand-matched constant.
 *  - **A single flat-at-the-horizon ramp.** Fog only blends a surface toward the
 *    fog colour — it cannot HIDE anything unless the background behind it is
 *    that colour too. Distant trees sit a few degrees above the horizon, where a
 *    plain `pow(h, 0.55)` gradient is already well on its way to the deep blue
 *    zenith, so fully-fogged geometry still read as pale shapes. This was first
 *    fixed with a separate haze band overriding the bottom 11.5°, but the seam
 *    where that band ended was itself visible. It is now one monotone curve with
 *    zero slope at the horizon, which holds the fog colour AND has no boundary.
 *    See `sky.horizonHold`.
 *  - **`depthWrite: false` with a high `renderOrder`**, so it draws LAST and is
 *    depth-tested against everything already in the buffer: only pixels with no
 *    geometry in front of them shade. Drawing it first (the usual skybox trick)
 *    pays full fragment cost for the ~60% of the screen terrain then paints
 *    over. The price is that the dome must ENCLOSE all geometry — see
 *    `sky.domeRadius` and `camera.far`.
 */
/**
 * How much of a full day the sky is showing: 1 at solar noon, 0 once the sun is
 * down. The single number every day/night blend is driven by — sky horizon, sky
 * zenith, cloud tint and the derived fog all read it, so they cannot drift apart.
 *
 * It comes from `resolveTimeOfDay`, computed from the SUN's height, and NOT from
 * `lighting.sunDirection` as it once did. That direction carries whichever body
 * is currently the light source, so at night it is the moon's — and blending the
 * sky on the moon's height brightens midnight toward the DAY palette.
 */
export function dayFactor(): number {
    return Math.max(0, Math.min(1, cfg.sky.dayFactor));
}

/**
 * @deprecated Kept as a thin alias so older call sites still read. The fog is no
 * longer "the horizon colour" — see `skyModel.deriveFogColor`.
 */
export function effectiveHorizonColor(): THREE.Color {
    return deriveFogColor();
}

export class SkyDome {

    private _mesh: THREE.Mesh;
    private _material: THREE.ShaderMaterial;

    constructor(scene: THREE.Scene) {
        const s = cfg.sky;
        const palette = environmentSkyPreset();
        // The TRUE sun and moon, not the lighting direction — the dome has to
        // draw the moon while gating the sun's glow off, so it needs both
        // regardless of which one is lighting the scene.
        const sun = s.sunDirection;
        const moon = s.moonDirection;

        this._material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: buildFragmentShader(),
            uniforms: {
                uZenithColor: { value: new THREE.Color(palette.zenith) },
                uZenithLowColor: { value: new THREE.Color(palette.zenithLow) },
                uHorizonColor: { value: new THREE.Color(palette.horizon) },
                uHorizonSunsetColor: { value: new THREE.Color(palette.horizonLow) },
                uSunGlowColor: { value: new THREE.Color(palette.glow) },
                uSunDirection: { value: new THREE.Vector3(sun.x, sun.y, sun.z).normalize() },
                uMoonDirection: { value: new THREE.Vector3(moon.x, moon.y, moon.z).normalize() },
                uMoonColor: { value: new THREE.Color(cfg.lighting.moonColor) },
                uSkyTopHeight: { value: s.skyTopHeight },
                uHorizonHold: { value: s.horizonHold },
                uDayFactor: { value: s.dayFactor },
            },
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,
        });

        this._mesh = new THREE.Mesh(
            new THREE.SphereGeometry(s.domeRadius, 32, 16),
            this._material,
        );
        // Drawn LAST, depth-tested. See the class comment.
        this._mesh.renderOrder = 1000;
        // Never culled: it's always around the camera, and its bounding sphere
        // moving with the camera every frame is wasted work.
        this._mesh.frustumCulled = false;
        scene.add(this._mesh);
    }

    /** Repaints the dome without rebuilding its geometry or shader program. */
    refreshEnvironment(): void {
        const palette = environmentSkyPreset();
        (this._material.uniforms.uZenithColor.value as THREE.Color).set(palette.zenith);
        (this._material.uniforms.uZenithLowColor.value as THREE.Color).set(palette.zenithLow);
        (this._material.uniforms.uHorizonColor.value as THREE.Color).set(palette.horizon);
        (this._material.uniforms.uHorizonSunsetColor.value as THREE.Color).set(palette.horizonLow);
        (this._material.uniforms.uSunGlowColor.value as THREE.Color).set(palette.glow);
    }

    /**
     * Re-centres the dome on the camera.
     *
     * This is what makes the shader's object-space position equal the view
     * direction — the vertex shader deliberately passes object space, not world
     * space, so the gradient depends only on which way you're looking and not on
     * how far the camera has travelled from the origin.
     */
    update(cameraPosition: THREE.Vector3): void {
        this._mesh.position.copy(cameraPosition);
    }
}

const VERTEX_SHADER = /* glsl */`
varying vec3 vLocalPosition;
void main() {
    vLocalPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Substitutes the glow constants from config into the shader source, so the
 * numbers exist in exactly one place and `skyModel.ts` reads the same ones.
 * GLSL needs float literals, hence toFixed(1) on the amplitudes.
 */
function buildFragmentShader(): string {
    const g = cfg.sky.sunGlow, m = cfg.sky.moonGlow;
    return FRAGMENT_SHADER
        .replace(/SUN_BROAD_EXP/g, g.broadExp.toFixed(1))
        .replace(/SUN_BROAD_AMP/g, g.broadAmp.toFixed(4))
        .replace(/SUN_TIGHT_EXP/g, g.tightExp.toFixed(1))
        .replace(/SUN_TIGHT_AMP/g, g.tightAmp.toFixed(4))
        .replace(/MOON_DISC_EXP/g, m.discExp.toFixed(1))
        .replace(/MOON_DISC_AMP/g, m.discAmp.toFixed(4))
        .replace(/MOON_HALO_EXP/g, m.haloExp.toFixed(1))
        .replace(/MOON_HALO_AMP/g, m.haloAmp.toFixed(4));
}

const FRAGMENT_SHADER = /* glsl */`
varying vec3 vLocalPosition;
uniform vec3 uZenithColor;
uniform vec3 uZenithLowColor;
uniform vec3 uHorizonColor;
uniform vec3 uHorizonSunsetColor;
uniform vec3 uSunGlowColor;
uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform vec3 uMoonColor;
uniform float uSkyTopHeight;
uniform float uHorizonHold;
uniform float uDayFactor;

void main() {
    vec3 dir = normalize(vLocalPosition);
    float h = dir.y;

    // The horizon warms toward sunset orange as the sun drops, on both sides of
    // the sky — stylised, not a scattering model.
    // Blended on uDayFactor, which comes from the SUN's height. Using the light
    // direction's y instead -- the obvious thing -- brightens midnight toward the
    // day palette, because after sunset that direction is the MOON's.
    vec3 horizon = mix(uHorizonSunsetColor, uHorizonColor, uDayFactor);
    // The zenith tracks the sun too. Blending only the horizon left the top of
    // the sky midday-blue under a sunset, which is the one part of a low-sun sky
    // people actually notice is wrong. Done in the shader rather than resolved
    // on the CPU so it mixes in LINEAR space, exactly like the horizon above --
    // two blends of the same pair in different spaces drift apart visibly.
    vec3 zenith = mix(uZenithLowColor, uZenithColor, uDayFactor);

    // ONE monotone ramp from the fog colour at the horizon to the zenith.
    //
    // 'horizon' here is exactly the colour the scene's fog blends toward (see
    // effectiveHorizonColor), so holding the low sky at it is what gives fogged
    // geometry nothing to stand out against.
    //
    // The previous version did this in two stages -- a pow(h, 0.55) gradient
    // plus a band that forced the bottom 11.5 degrees back to the horizon
    // colour -- and the seam where the band ended was visible, because a sub-1
    // exponent rises fastest at exactly the height the band was flattening.
    // smoothstep raised above 1 leaves the horizon with zero slope instead, so
    // there is no rate change anywhere. See sky.horizonHold.
    //
    // max(h, 0.0) clamps below-horizon sky to pure fog colour, so any sliver of
    // dome showing through a chunk seam is invisible against fogged terrain.
    // (No backticks in here -- this is inside a template literal.)
    float t = pow(smoothstep(0.0, uSkyTopHeight, max(h, 0.0)), uHorizonHold);
    vec3 sky = mix(horizon, zenith, t);

    // Sun glow, faded out as the sun goes under rather than switched, so an hour
    // just after sunset still has light lingering where it went down.
    //
    // The amplitudes and exponents are interpolated from sky.sunGlow/moonGlow so
    // that skyModel.ts -- which mirrors this shader on the CPU to derive the fog
    // colour -- reads the same numbers. Do not hardcode them here.
    float sunUp = smoothstep(-0.07, 0.02, uSunDirection.y);
    float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunGlowColor * sunUp * (pow(sunDot, SUN_BROAD_EXP) * SUN_BROAD_AMP + pow(sunDot, SUN_TIGHT_EXP) * SUN_TIGHT_AMP);

    // The moon: a tight disc plus a soft halo, gated the same way. A lobe falls
    // to half at sqrt(2*ln2/exp) radians, so the exponent sets its angular size
    // and does the work a texture would, for a few ALU.
    float moonUp = smoothstep(-0.02, 0.05, uMoonDirection.y);
    float moonDot = max(dot(dir, normalize(uMoonDirection)), 0.0);
    sky += uMoonColor * moonUp * (pow(moonDot, MOON_DISC_EXP) * MOON_DISC_AMP + pow(moonDot, MOON_HALO_EXP) * MOON_HALO_AMP);

    gl_FragColor = vec4(sky, 1.0);

    // MANDATORY, and easy to lose. three.js appends the linear -> output
    // colour-space conversion only to its OWN materials; a ShaderMaterial that
    // writes gl_FragColor itself gets no encoding, so linear values land
    // untouched in an sRGB framebuffer and render far too dark.
    //
    // This was a real bug, not a theoretical one: the horizon colour is linear
    // (0.3511, 0.483, 0.6652), which without this line displayed as rgb(89,
    // 123, 170) instead of rgb(160, 185, 213) -- while the scene's fog, going
    // through a built-in material, rendered the correct 160,185,213. Same
    // colour, two encodings, so fogged geometry sat pale against a much darker
    // sky. Chasing that as a gradient or fog-density problem cost several
    // rounds; a linear-space check even 'proved' the two matched, because in
    // linear space they did.
    #include <colorspace_fragment>
}
`;
