import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import {
    lightFrame, bakeShadowAtlas, type ShadowAtlas,
} from '../procedural/shadowSilhouette';

/**
 * ProjectedShadows — shadows computed inside the RECEIVER's fragment shader.
 *
 * ## Why this replaces the decal quads
 *
 * A shadow is not a dark shape on the ground; it is the absence of the sun. The
 * decals composited a dark quad ON TOP of already-lit ground, which is why they
 * read as plates however good the silhouette was: hard uniform edge, no hue
 * shift, and a visible separation at grazing angles. Draping them on the terrain
 * would not have fixed any of that — it was never a placement problem, it was a
 * question of WHERE IN THE PIPELINE the shadow is applied.
 *
 * Here the occlusion is injected after `lights_fragment_begin` and scales
 * `reflectedLight.directDiffuse`/`directSpecular` only. So it removes the sun's
 * contribution and leaves ambient and the environment map untouched — which is
 * what makes a shadow shift cool rather than merely dark. And there is no quad,
 * so the whole draping problem simply does not exist: the shadow is evaluated
 * per fragment, at that fragment's own position.
 *
 * ## Why the lookup is in the light's frame, not on the ground
 *
 * The obvious formulation projects the silhouette onto the ground plane and
 * samples it by world XZ. That works for flat ground and smears badly on
 * anything else: every point of a vertical surface at the same XZ gets the same
 * value, so a shadow crossing a tree trunk becomes a vertical streak.
 *
 * Instead sample in the light's own lateral coordinates:
 *
 *     rel = fragmentWorld - casterOrigin
 *     r   = dot(rel, R)      across the light
 *     u   = dot(rel, U)      up the light's image
 *     d   = -dot(rel, S)     metres DOWN-light of the caster
 *
 * R and U are both perpendicular to the light, so (r, u) is exactly the
 * coordinate the orthographic bake was indexed by — this is a shadow-map lookup
 * with the depth test removed. It is correct on any surface orientation, and the
 * 1/sin(elevation) stretch emerges for free: moving one metre along the ground
 * away from the sun changes `u` by only sin(elevation), so covering a caster's
 * `u` extent takes 1/sin(elevation) metres of ground. Nothing applies the
 * stretch by hand and nothing can get its sign wrong.
 *
 * ## What no depth test costs
 *
 * Two artefacts, both handled:
 *
 *  - A shadow would reach infinitely far down-light. `d` fades it out over
 *    `fadeNear`..`fadeFar`.
 *  - A shadow would fall on surfaces BETWEEN the caster and the sun. `d <= 0`
 *    rejects those outright.
 *
 * What genuinely cannot be recovered is a caster shadowing ITSELF, since that is
 * precisely the case the depth test exists to resolve. `attach`'s `skip` option
 * exists so a caster's own material can opt out of its own silhouette rather
 * than darken its whole down-light half on top of what N·L already does.
 *
 * ## Cost
 *
 * Zero extra draw calls and zero render targets per frame — the atlas is baked
 * once at boot. The price is per-fragment and O(slots) on every receiver: a few
 * dot products, and a texture fetch only for fragments actually inside a
 * caster's footprint. `maxCasters` is therefore the dial that matters, and it is
 * a COMPILE-TIME constant in the shader, so changing it recompiles.
 */

/** Options for one receiver material. */
export interface ReceiverOptions {
    /**
     * Also sample the top-down tree mask. GROUND RECEIVERS ONLY — the mask is
     * indexed by world XZ, so on a vertical surface every height at the same XZ
     * reads the same value and the shadow becomes a vertical streak. Terrain,
     * road and markers: yes. Vehicles: no.
     */
    groundMask?: boolean;
    /**
     * Unproject along the light before sampling the tree mask, for a receiver
     * that is NOT the ground — a vehicle roof, a prop, anything raised.
     *
     * The mask is indexed by GROUND position. A fragment `h` metres up is lit by
     * a ray that meets the ground `h * |S.xz| / S.y` further down-light, so
     * sampling at the fragment's own XZ reads the wrong place entirely: at a 24
     * degree sun that is 2.22m of error per metre of height, i.e. ~3.8m for a car
     * roof. Ground receivers must NOT set this — their own height already IS the
     * plane the footprint was drawn on, so the shift would break the draping.
     */
    maskLift?: boolean;

    /**
     * Caster handle whose silhouette this material must ignore — for a caster's
     * own material, where no depth test means self-shadowing would just darken
     * the entire down-light half. -1 to receive everything.
     */
    skip?: number;
}

interface PendingCaster {
    handle: number;
    x: number; y: number; z: number;
    cos: number; sin: number;
    /** Sort key; lower is kept when there are more casters than slots. */
    priority: number;
}

export class ProjectedShadows {
    private _casterGeometries: THREE.BufferGeometry[][] = [];
    private _atlas: ShadowAtlas | null = null;
    private _frame = lightFrame(cfg.lighting.sunDirection);

    /** Shared uniform objects. Every patched material references THESE, so one write updates all of them. */
    private _uniforms: Record<string, THREE.IUniform>;

    private _origin: THREE.Vector4[] = [];
    private _shape: THREE.Vector4[] = [];
    private _basis: THREE.Vector4[] = [];

    private _pending: PendingCaster[] = [];
    private readonly _slots: number;

    /**
     * Y a parked slot is sent to. Chosen so `d = -dot(rel, S)` comes out hugely
     * NEGATIVE and the shader's `d <= 0` test rejects the slot before it can
     * reach a texture fetch — which is why unused slots cost almost nothing and
     * why the loop needs no dynamic bound (GLSL ES 1.0 will not give us one).
     */
    private static readonly PARKED_Y = -1e6;

    constructor() {
        const ps = cfg.lighting.projectedShadows;
        this._slots = Math.max(1, Math.round(ps.maxCasters));

        for (let i = 0; i < this._slots; i++) {
            this._origin.push(new THREE.Vector4(0, ProjectedShadows.PARKED_Y, 0, 0));
            this._shape.push(new THREE.Vector4(0, 0, 0, 0));
            this._basis.push(new THREE.Vector4(1, 0, 0, 1));
        }

        const S = this._frame.S;
        const liftScale = -1 / Math.max(1e-3, S.y);
        this._uniforms = {
            uProjShadowAtlas: { value: null },
            uProjShadowOrigin: { value: this._origin },
            uProjShadowShape: { value: this._shape },
            uProjShadowBasis: { value: this._basis },
            uProjShadowSun: { value: new THREE.Vector3(S.x, S.y, S.z) },
            uProjShadowUy: { value: this._frame.U.y },
            uProjShadowGrid: { value: new THREE.Vector4(1, 1, 1, 1) },
            uProjShadowFade: { value: new THREE.Vector2(ps.fadeNear, ps.fadeFar) },
            uProjShadowOpacity: { value: ps.opacity },
            // The tree mask. Declared unconditionally — a material that does not
            // sample it simply never uploads it — so both mechanisms share one
            // uniform block and one write updates every receiver.
            uTreeMask: { value: null },
            uTreeMaskRect: { value: new THREE.Vector3() },
            // xy: ground shift per metre of height, -S.xz / S.y. z: the
            // reference plane the shift is measured from, updated per frame.
            uTreeMaskLift: { value: new THREE.Vector4(0, 0, 0, 1) },
            uTreeMaskParams: {
                value: new THREE.Vector2(
                    cfg.lighting.treeShadows.opacity,
                    cfg.lighting.treeShadows.edgeFade,
                ),
            },
        };
    }

    /** Registers a caster's geometry (or its parts) and returns its handle. */
    register(geometry: THREE.BufferGeometry | THREE.BufferGeometry[]): number {
        this._casterGeometries.push(Array.isArray(geometry) ? geometry : [geometry]);
        return this._casterGeometries.length - 1;
    }

    /**
     * Points the receivers at the tree mask. Called once the mask's render
     * target exists; the rect vector is then shared and updated in place.
     */
    setTreeMaskHeightScale(metres: number): void {
        (this._uniforms.uTreeMaskLift.value as THREE.Vector4).w = metres;
    }

    setTreeMask(texture: THREE.Texture, rect: THREE.Vector3): void {
        this._uniforms.uTreeMask.value = texture;
        this._uniforms.uTreeMaskRect.value = rect;
        const S = this._frame.S;
        const lift = -1 / Math.max(1e-3, S.y);
        const v = this._uniforms.uTreeMaskLift.value as THREE.Vector4;
        v.x = S.x * lift; v.y = S.z * lift;
    }

    /**
     * Reference ground height the lifted lookup measures from, updated per frame.
     *
     * The road under the car: every vehicle is on it, and its own height is
     * exactly right for the player's car, which is the one at screen centre. A
     * vehicle far ahead on road several metres higher picks up an error of that
     * difference times the lift — accepted, because its shadow is small and
     * fogged by then.
     */
    setTreeMaskPlane(y: number): void {
        (this._uniforms.uTreeMaskLift.value as THREE.Vector4).z = y;
    }

    /** Bakes the atlas. Needs a renderer, so it runs once the renderer exists. */
    bake(renderer: THREE.WebGLRenderer): void {
        if (this._casterGeometries.length === 0) return;
        const ps = cfg.lighting.projectedShadows;
        this._atlas = bakeShadowAtlas(renderer, this._casterGeometries, this._frame, ps.textureSize);
        this._uniforms.uProjShadowAtlas.value = this._atlas.texture;
        const { cols, rows } = this._atlas;
        (this._uniforms.uProjShadowGrid.value as THREE.Vector4)
            .set(cols, rows, 1 / cols, 1 / rows);
    }

    /**
     * Installs the receiver patch on a material. Safe to call on any lit
     * material — terrain, road, props, vehicles — which is the point: a shadow
     * lands on whatever carries the patch, so this is what lets a bus's shadow
     * fall across the player's car and not just onto the asphalt.
     */
    attach(material: THREE.Material, options: ReceiverOptions = {}): void {
        if (!cfg.lighting.projectedShadows.enabled) return;
        const skip = options.skip ?? -1;
        const groundMask = options.groundMask === true
            && cfg.lighting.treeShadows.enabled;
        const maskLift = options.maskLift === true;
        const count = this._slots;
        const uniforms = this._uniforms;

        material.onBeforeCompile = (shader) => {
            // An UNLIT material has no direct light to attenuate, so the patch
            // below would compile cleanly and do nothing at all. Worth saying
            // out loud — a silent no-op here looks exactly like a broken
            // shadow, and that is an expensive thing to debug twice.
            if (!shader.fragmentShader.includes('#include <lights_fragment_begin>')) {
                console.warn(
                    '[ProjectedShadows] attached to a material with no lighting ' +
                    `chunk (${material.type}); it will not receive shadows. Only ` +
                    'lit materials (MeshStandard/MeshPhong/MeshLambert) can.',
                );
                return;
            }
            for (const key in uniforms) shader.uniforms[key] = uniforms[key];

            shader.vertexShader = shader.vertexShader
                .replace('void main() {', 'varying vec3 vProjShadowWorld;\nvoid main() {')
                // After `project_vertex`, `transformed` is final — morph targets
                // and skinning have already had their say — so this is the one
                // place the world position is guaranteed to be the real one.
                .replace(
                    '#include <project_vertex>',
                    `#include <project_vertex>
    {
        // MUST re-apply the instance/batch matrix by hand. three.js applies it
        // inside project_vertex to mvPosition, NOT to \`transformed\`, so
        // \`modelMatrix * transformed\` alone gives EVERY instance the mesh's
        // own origin. That is not a subtle error: an instanced receiver then
        // samples one single point for all its instances, and the shadow simply
        // never appears on it. It is what hid the shadow on the road markers.
        vec4 projShadowPos = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
            projShadowPos = batchingMatrix * projShadowPos;
        #endif
        #ifdef USE_INSTANCING
            projShadowPos = instanceMatrix * projShadowPos;
        #endif
        vProjShadowWorld = (modelMatrix * projShadowPos).xyz;
    }`,
                );

            shader.fragmentShader = shader.fragmentShader
                .replace('void main() {', `
varying vec3 vProjShadowWorld;
uniform sampler2D uProjShadowAtlas;
uniform vec4 uProjShadowOrigin[${count}];
uniform vec4 uProjShadowShape[${count}];
uniform vec4 uProjShadowBasis[${count}];
uniform vec3 uProjShadowSun;
uniform float uProjShadowUy;
uniform vec4 uProjShadowGrid;
uniform vec2 uProjShadowFade;
uniform float uProjShadowOpacity;
${groundMask ? `
uniform sampler2D uTreeMask;
uniform vec3 uTreeMaskRect;
uniform vec4 uTreeMaskLift;
uniform vec2 uTreeMaskParams;

// Top-down tree shadow. Indexed by ground position, which is precisely why it
// drapes: this fragment's own XZ is the lookup, whatever height it sits at.
float treeMaskFactor() {
    // Ground point the light ray through this fragment came over. Zero shift
    // for ground receivers, where the fragment's own height IS that plane.
    vec2 groundXZ = vProjShadowWorld.xz${maskLift
        ? ' + uTreeMaskLift.xy * (vProjShadowWorld.y - uTreeMaskLift.z)' : ''};
    vec2 uv = (groundXZ - uTreeMaskRect.xy) / uTreeMaskRect.z;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
    vec4 m = texture2D(uTreeMask, uv);
    float a = m.a;${maskLift ? `
    // Reject occluders BELOW this fragment. Without a depth test the mask only
    // says the ray is blocked somewhere; red says how high the blocker was, and
    // a fragment 1.7m up needs it blocked above 1.7m. This is what keeps the
    // shadow on a car aligned with the shadow on the road instead of starting
    // ~11m early on the sunward side of the tree.
    float occluderY = m.r * uTreeMaskLift.w;
    float fragY = vProjShadowWorld.y - uTreeMaskLift.z;
    a *= smoothstep(fragY - 0.25, fragY + 0.25, occluderY);` : ''}
    // Fade the window's own border, or its straight edge travels across the
    // terrain with the car as a visible line.
    vec2 edge = min(uv, 1.0 - uv);
    a *= smoothstep(0.0, uTreeMaskParams.y, min(edge.x, edge.y));
    return 1.0 - uTreeMaskParams.x * a;
}
` : ''}
float projShadowFactor() {
    float occ = 0.0;
    for (int i = 0; i < ${count}; i++) {
        ${skip >= 0 ? `if (i == ${skip}) continue;` : ''}
        vec4 origin = uProjShadowOrigin[i];
        vec3 rel = vProjShadowWorld - origin.xyz;
        // Metres down-light of the caster. Negative means the fragment sits
        // between the caster and the sun, so it cannot be in this shadow — and
        // it is also how a parked slot is rejected before any texture fetch.
        float d = -dot(rel, uProjShadowSun);
        if (d <= 0.0) continue;

        // R and U pre-rotated by the caster's yaw on the CPU, so the footprint
        // turns with the vehicle. Both stay perpendicular to the light in the
        // caster's own frame; R is horizontal so only x/z vary, and U's y
        // component is invariant under a yaw and is passed once.
        vec4 basis = uProjShadowBasis[i];
        float r = rel.x * basis.x + rel.z * basis.y;
        float u = rel.x * basis.z + rel.y * uProjShadowUy + rel.z * basis.w;

        vec4 shape = uProjShadowShape[i];
        vec2 cellUv = vec2((r - shape.x) * shape.z, (u - shape.y) * shape.w);
        if (cellUv.x < 0.0 || cellUv.x > 1.0 || cellUv.y < 0.0 || cellUv.y > 1.0) continue;

        vec2 cell = vec2(mod(origin.w, uProjShadowGrid.x), floor(origin.w * uProjShadowGrid.z));
        float a = texture2D(uProjShadowAtlas, (cell + cellUv) * uProjShadowGrid.zw).a;
        a *= 1.0 - smoothstep(uProjShadowFade.x, uProjShadowFade.y, d);
        occ = max(occ, a);
    }
    return 1.0 - uProjShadowOpacity * occ;
}

void main() {`)
                // Scales the DIRECT terms only. Ambient and the environment map
                // survive, which is what makes shadow read as shadow rather
                // than as a dark decal.
                .replace(
                    '#include <lights_fragment_begin>',
                    `#include <lights_fragment_begin>
    {
        float projShadow = projShadowFactor();${groundMask ? '\n        projShadow *= treeMaskFactor();' : ''}
        reflectedLight.directDiffuse *= projShadow;
        reflectedLight.directSpecular *= projShadow;
    }`,
                );
        };

        // Materials that differ only in their patch must not share a compiled
        // program. Without this three.js keys purely on the material's own
        // parameters and two receivers with different `skip` get whichever
        // program was built first.
        material.customProgramCacheKey = () => `projshadow:${count}:${skip}:${groundMask}:${maskLift}`;
        material.needsUpdate = true;
    }

    /** Starts a frame's caster list. */
    begin(): void {
        this._pending.length = 0;
    }

    /**
     * Submits a caster at a world (render-space) position.
     *
     * `yaw` turns the footprint with the vehicle. `priority` decides who keeps a
     * slot when there are more casters than slots — pass the squared distance
     * from the camera, or a negative number to pin something (the player's car)
     * in place regardless.
     */
    add(handle: number, x: number, y: number, z: number, yaw: number, priority: number): void {
        this._pending.push({
            handle, x, y, z,
            cos: Math.cos(yaw), sin: Math.sin(yaw),
            priority,
        });
    }

    /** Sorts, culls to the slot count, and writes the uniforms. */
    commit(): void {
        if (this._atlas === null) return;

        const pending = this._pending;
        if (pending.length > this._slots) {
            pending.sort((a, b) => a.priority - b.priority);
        }
        const live = Math.min(pending.length, this._slots);
        const R = this._frame.R, U = this._frame.U;

        for (let i = 0; i < live; i++) {
            const p = pending[i];
            const cell = this._atlas.cells[p.handle];

            this._origin[i].set(p.x, p.y, p.z, cell.cell);
            this._shape[i].set(cell.rMin, cell.uMin, cell.invSpanR, cell.invSpanU);

            // Rotate R and U about Y by the caster's yaw. Sampling `rel` against
            // a rotated basis is the same as rotating `rel` into the caster's
            // frame, and costs four floats instead of a matrix.
            //
            // NOTE this leaves the basis no longer exactly perpendicular to the
            // world light, so the silhouette used is the one for a slightly
            // wrong light azimuth. That error is second order in the yaw, while
            // NOT rotating leaves a shadow that fails to turn with a vehicle —
            // first order in its length, and far more visible on a 9m bus.
            this._basis[i].set(
                R.x * p.cos + R.z * p.sin,
                -R.x * p.sin + R.z * p.cos,
                U.x * p.cos + U.z * p.sin,
                -U.x * p.sin + U.z * p.cos,
            );
        }
        // Park the rest below the world, where the shader's `d <= 0` test drops
        // them before any work.
        for (let i = live; i < this._slots; i++) {
            this._origin[i].set(0, ProjectedShadows.PARKED_Y, 0, 0);
        }
    }

    /** Live caster count last commit, for the perf HUD. */
    get liveCount(): number {
        return Math.min(this._pending.length, this._slots);
    }
}
