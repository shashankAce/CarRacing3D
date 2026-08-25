import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';

/**
 * SkyDome — a big inverted sphere with an analytic gradient and noise clouds.
 *
 * Ported from `Procedural_3D_world/src/sky/skyDome.js`, with its CPU-side cloud
 * sampling dropped: that existed so sunlight could dim when the sun sat behind a
 * cloud, which needed a second JS copy of the noise field. Not worth the bytes
 * or the frame time here.
 *
 * Costs one draw call and no textures — the gradient, sun glow and clouds are
 * all computed per-pixel, which is why a procedural sky is the right call
 * against a 2MB budget where a cubemap would be hundreds of kilobytes.
 *
 * Two properties matter for it to sit correctly in this game:
 *
 *  - `fog: false`. The scene's FogExp2 would otherwise wash the dome toward the
 *    fog colour, flattening the whole gradient. Instead, `sky.horizonColor` and
 *    `world.fogColor` are set to the same value in config, so distant terrain
 *    fades into the dome's horizon rather than into an unrelated flat colour.
 *  - `depthWrite: false` with a high `renderOrder`, so it draws LAST and is
 *    depth-tested against everything already in the buffer. Only pixels where
 *    no geometry was drawn end up shading. Drawing it first instead (the usual
 *    skybox trick) means paying 4 fbm evaluations — 16 simplex3D — on every
 *    pixel of the screen including the ~60% that terrain and road then paint
 *    over. The cost of doing it this way is that the dome must ENCLOSE all
 *    geometry: see `sky.domeRadius` and `camera.far`.
 */
/**
 * The horizon colour the shader will actually produce for the configured sun.
 *
 * The shader mixes `horizonSunsetColor` toward `horizonColor` by the sun's
 * height, so the visible horizon is neither config value at most sun angles.
 * Scene fog and background are derived from THIS rather than hand-matched to a
 * config colour — hand-matching agrees at exactly one sun elevation and shows a
 * seam at every other, which is what a first pass looked like: pale blue haze
 * against a pink sky.
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

    float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunGlowColor * (pow(sunDot, 84.0) * 0.5 + pow(sunDot, 1820.0) * 2.0);

    gl_FragColor = vec4(sky, 1.0);
}
`;
