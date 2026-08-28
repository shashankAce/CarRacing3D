import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';
import { activeEnvironmentBlend, environmentSkyPreset } from '../../config/environment';
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
export function effectiveHorizonColor(environmentBlend = activeEnvironmentBlend()): THREE.Color {
    return deriveFogColor(environmentBlend);
}

export class SkyDome {

    private _mesh: THREE.Mesh;
    private _material: THREE.ShaderMaterial;
    private _paletteScratch = new THREE.Color();

    constructor(scene: THREE.Scene) {
        const s = cfg.sky;
        const palette = environmentSkyPreset('forest');
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
        this.refreshEnvironment();
    }

    /** Repaints the dome without rebuilding its geometry or shader program. */
    refreshEnvironment(blend = activeEnvironmentBlend()): void {
        const forest = environmentSkyPreset('forest');
        const desert = environmentSkyPreset('desert');
        this._blendUniform('uZenithColor', forest.zenith, desert.zenith, blend);
        this._blendUniform('uZenithLowColor', forest.zenithLow, desert.zenithLow, blend);
        this._blendUniform('uHorizonColor', forest.horizon, desert.horizon, blend);
        this._blendUniform('uHorizonSunsetColor', forest.horizonLow, desert.horizonLow, blend);
        this._blendUniform('uSunGlowColor', forest.glow, desert.glow, blend);
    }

    private _blendUniform(name: string, forest: number, desert: number, blend: number): void {
        (this._material.uniforms[name].value as THREE.Color)
            .set(forest)
            .lerp(this._paletteScratch.set(desert), blend);
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
varying vec3 vViewDirection;
varying vec3 vMoonViewDirection;
uniform vec3 uMoonDirection;
void main() {
    vLocalPosition = position;
    // Direction vectors use w=0 semantics: camera/object translation must not
    // affect either the sampled sky ray or the moon's celestial direction.
    vViewDirection = mat3(modelViewMatrix) * position;
    vMoonViewDirection = mat3(viewMatrix) * uMoonDirection;
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
    // The config keeps angular edges as dot products because skyModel.ts uses
    // them directly.  The GPU converts those angles to projected view-space
    // radii so the disc stays circular away from the centre of the screen.
    const moonInnerRadius = Math.sqrt(1 - m.discInnerDot ** 2) / m.discInnerDot;
    const moonOuterRadius = Math.sqrt(1 - m.discOuterDot ** 2) / m.discOuterDot;
    // The old mask blurred across the whole inner-to-outer interval (roughly a
    // quarter of the disc radius). Keep its perceived size, but let fwidth()
    // make the transition exactly as wide as the current screen pixels need.
    const moonRadius = (moonInnerRadius + moonOuterRadius) * 0.5;
    return FRAGMENT_SHADER
        .replace(/SUN_BROAD_EXP/g, g.broadExp.toFixed(1))
        .replace(/SUN_BROAD_AMP/g, g.broadAmp.toFixed(4))
        .replace(/SUN_TIGHT_EXP/g, g.tightExp.toFixed(1))
        .replace(/SUN_TIGHT_AMP/g, g.tightAmp.toFixed(4))
        .replace(/MOON_DISC_AMP/g, m.discAmp.toFixed(4))
        .replace(/MOON_DISC_RADIUS/g, moonRadius.toFixed(8));
}

const FRAGMENT_SHADER = /* glsl */`
varying vec3 vLocalPosition;
varying vec3 vViewDirection;
varying vec3 vMoonViewDirection;
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

// A few layered maria and crater bowls give the small disc readable lunar
// detail without adding a texture file, sampler, or download to the playable.
float moonCrater(vec2 p, vec2 centre, float radius) {
    float d = length(p - centre) / radius;
    float bowl = 1.0 - smoothstep(0.18, 0.92, d);
    float rim = smoothstep(0.70, 0.91, d) * (1.0 - smoothstep(0.91, 1.16, d));
    return rim * 0.13 - bowl * 0.17;
}

float moonSurface(vec2 p) {
    float tone = 0.76;

    // Broad overlapping waves read as the moon's dark basalt plains at this
    // size; unlike high-frequency noise, they survive mobile resolution scale.
    tone += sin(p.x * 5.7 + p.y * 2.3) * 0.035;
    tone += sin(p.x * 9.1 - p.y * 6.4 + 1.7) * 0.025;
    tone += moonCrater(p, vec2(-0.34,  0.28), 0.24);
    tone += moonCrater(p, vec2( 0.28,  0.37), 0.16);
    tone += moonCrater(p, vec2( 0.38, -0.18), 0.22);
    tone += moonCrater(p, vec2(-0.15, -0.36), 0.13);
    tone += moonCrater(p, vec2(-0.50, -0.18), 0.10);
    tone += moonCrater(p, vec2( 0.05,  0.05), 0.08);

    // Gentle limb darkening makes the flat shader disc read as a sphere.
    float limb = sqrt(max(0.0, 1.0 - dot(p, p)));
    tone *= mix(0.66, 1.0, smoothstep(0.0, 0.48, limb));
    return clamp(tone, 0.38, 0.96);
}

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

    // The moon is a solid disc with a sub-pixel softened rim, not a radial
    // intensity lobe. That keeps the moon lit without a sun-like halo.
    float moonUp = smoothstep(-0.02, 0.05, uMoonDirection.y);
    // Measuring an angular cap with dot(dir, moon) makes it project as an oval
    // when it is away from the optical axis. Compare perspective-divided view
    // directions instead: x/-z and y/-z have the same pixel scale, regardless
    // of viewport aspect ratio, so this distance is a true screen-space circle.
    vec3 viewDir = normalize(vViewDirection);
    vec3 moonViewDir = normalize(vMoonViewDirection);
    vec2 screenDir = viewDir.xy / max(-viewDir.z, 0.0001);
    vec2 moonScreenDir = moonViewDir.xy / max(-moonViewDir.z, 0.0001);
    vec2 moonOffset = screenDir - moonScreenDir;
    float moonScreenDistance = length(moonOffset);
    // fwidth tracks one screen pixel, so the edge is crisp at every resolution
    // but still anti-aliased instead of stair-stepped.
    float moonEdgeAA = max(fwidth(moonScreenDistance) * 0.65, 0.000001);
    float moonDisc = 1.0 - smoothstep(
        MOON_DISC_RADIUS - moonEdgeAA,
        MOON_DISC_RADIUS + moonEdgeAA,
        moonScreenDistance
    );
    // A direction behind the camera also has projected x/y coordinates; mask
    // it explicitly so it cannot mirror a false moon into the visible sky.
    moonDisc *= 1.0 - step(-0.0001, moonViewDir.z);
    if (moonDisc > 0.0) {
        float lunarTexture = moonSurface(moonOffset / MOON_DISC_RADIUS);
        sky += uMoonColor * lunarTexture * moonUp * moonDisc * MOON_DISC_AMP;
    }

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
