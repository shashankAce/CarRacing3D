import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';

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
export function effectiveHorizonColor(): THREE.Color {
    const d = cfg.lighting.sunDirection;
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    const sunHeight = Math.max(0, Math.min(1, d.y / len));
    return new THREE.Color(cfg.sky.horizonSunsetColor)
        .lerp(new THREE.Color(cfg.sky.horizonColor), sunHeight);
}

export class SkyDome {

    private _mesh: THREE.Mesh;
    private _material: THREE.ShaderMaterial;

    constructor(scene: THREE.Scene) {
        const s = cfg.sky;
        const sun = cfg.lighting.sunDirection;

        this._material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            uniforms: {
                uZenithColor: { value: new THREE.Color(s.zenithColor) },
                uHorizonColor: { value: new THREE.Color(s.horizonColor) },
                uHorizonSunsetColor: { value: new THREE.Color(s.horizonSunsetColor) },
                uSunGlowColor: { value: new THREE.Color(s.sunGlowColor) },
                uSunDirection: { value: new THREE.Vector3(sun.x, sun.y, sun.z).normalize() },
                uSkyTopHeight: { value: s.skyTopHeight },
                uHorizonHold: { value: s.horizonHold },
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

const FRAGMENT_SHADER = /* glsl */`
varying vec3 vLocalPosition;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uHorizonSunsetColor;
uniform vec3 uSunGlowColor;
uniform vec3 uSunDirection;
uniform float uSkyTopHeight;
uniform float uHorizonHold;

void main() {
    vec3 dir = normalize(vLocalPosition);
    float h = dir.y;

    // The horizon warms toward sunset orange as the sun drops, on both sides of
    // the sky — stylised, not a scattering model.
    float sunHeight = clamp(uSunDirection.y, 0.0, 1.0);
    vec3 horizon = mix(uHorizonSunsetColor, uHorizonColor, sunHeight);

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
    vec3 sky = mix(horizon, uZenithColor, t);

    float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunGlowColor * (pow(sunDot, 84.0) * 0.5 + pow(sunDot, 1820.0) * 2.0);

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
