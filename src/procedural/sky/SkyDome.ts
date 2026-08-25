import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';

/**
 * SkyDome — a large inverted sphere with an analytic gradient, a sun glow and a
 * horizon haze band.
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
 *  - **The haze band.** Fog only blends a surface toward the fog colour — it
 *    cannot HIDE anything unless the background behind it is that colour too.
 *    Distant trees sit a few degrees above the horizon, where the plain gradient
 *    is already well on its way to the deep blue zenith, so fully-fogged
 *    geometry still read as pale shapes. Forcing the low sky to exactly the fog
 *    colour is what makes distance actually occlude. See `sky.hazeHeight`.
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
                uHazeHeight: { value: s.hazeHeight },
                uHazeStrength: { value: s.hazeStrength },
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
uniform float uHazeHeight;
uniform float uHazeStrength;

void main() {
    vec3 dir = normalize(vLocalPosition);
    float h = dir.y;

    // The horizon warms toward sunset orange as the sun drops, on both sides of
    // the sky — stylised, not a scattering model.
    float sunHeight = clamp(uSunDirection.y, 0.0, 1.0);
    vec3 horizon = mix(uHorizonSunsetColor, uHorizonColor, sunHeight);

    float above = pow(clamp(h, 0.0, 1.0), 0.55);
    vec3 sky = mix(horizon, uZenithColor, above);

    // Below eye level, fade to a duller horizon rather than cutting off at h=0.
    float below = pow(clamp(-h, 0.0, 1.0), 0.5);
    sky = mix(sky, horizon * 0.6, below);

    // Haze band. The 'horizon' value here is exactly the colour the scene's fog
    // blends toward (see effectiveHorizonColor), so flattening the low sky to it
    // is what gives fogged geometry nothing to stand out against. Applied BEFORE
    // the sun glow, so a low sun still burns through the haze.
    // (No backticks in here -- this is inside a template literal.)
    float haze = 1.0 - smoothstep(0.0, uHazeHeight, max(h, 0.0));
    sky = mix(sky, horizon, haze * uHazeStrength);

    float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunGlowColor * (pow(sunDot, 84.0) * 0.5 + pow(sunDot, 1820.0) * 2.0);

    gl_FragColor = vec4(sky, 1.0);
}
`;
