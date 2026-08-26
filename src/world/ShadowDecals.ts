import * as THREE from 'three';
import { Node, InstancedMesh3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { bakeShadowSilhouette, lightFrame, type ShadowSilhouette } from '../procedural/shadowSilhouette';

interface Batch {
    silhouette: ShadowSilhouette;
    mesh: InstancedMesh3D;
    count: number;
}

/**
 * ShadowDecals — one baked silhouette per caster shape, projected onto the
 * ground.
 *
 * ## Why this instead of a shadow map
 *
 * Measured with the real-time path on and off:
 *
 * ```
 *                draw calls   triangles   programs
 *   shadows ON        111        50,102        15
 *   shadows OFF        96        45,834        12
 * ```
 *
 * The depth pass costs 15 draws, 4,268 triangles and 3 extra programs a frame,
 * and that is the cheap half — all 72 RECEIVERS take a PCF sample per fragment,
 * and the receivers are the terrain and the road, i.e. most of the screen. On a
 * fill-bound mobile GPU that per-pixel tax is what made shadows a 42ms
 * regression at 1024/70m.
 *
 * Here each shape is snapshotted ONCE (the light direction is fixed at boot, so
 * every shadow in the game is a constant image) and drawn as an instanced quad:
 * one draw per distinct shape, two triangles each, and no per-pixel cost outside
 * the shadows themselves.
 *
 * ## Shape is preserved exactly, not approximated
 *
 * `shadowSilhouette.ts` has the derivation. The short of it: bake with an
 * orthographic camera looking along the light, and the image maps to the ground
 * by scaling its vertical axis by 1/sin(elevation) and rotating it down-light.
 * That is the true projection, so a tree's shadow has its trunk and canopy and a
 * car's has its cabin step — and any future model works with no extra code,
 * because the silhouette and the bounds both come out of the mesh.
 *
 * ## Where it is still wrong: irregular terrain
 *
 * A decal is ONE quad, so it is planar. Tilting it to the ground normal under the
 * caster (which is what `add` does with the normal it is given) is right on a
 * uniform slope and wrong across a crest, where a real shadow would bend.
 *
 * That is a deliberate stopping point, not an oversight. The alternatives:
 *
 *  - Tessellate each decal and sample `heightAt` per vertex. Drapes correctly,
 *    but every decal becomes unique geometry — no instancing — and it costs
 *    thousands of height samples a frame.
 *  - Draw all silhouettes into one top-down render target and have the terrain
 *    and road shaders sample it by world XZ. Correct on ANY terrain, because the
 *    mask is a function of ground position and drapes by construction. Costs one
 *    512-square target (the same fill the shadow map already paid) plus a fetch
 *    per ground fragment, and needs both ground materials patched.
 *
 * Worth knowing which casters this actually affects: the cars and traffic sit on
 * the ROAD, which is a near-flat ribbon, so they are effectively exact. It is
 * only trees on slopes that show the seam.
 */
export class ShadowDecals {

    private _scene: Scene;
    private _frame = lightFrame(cfg.lighting.sunDirection);
    private _pending: THREE.BufferGeometry[][] = [];
    private _batches: Batch[] = [];
    private _baked = false;

    private _matrix = new THREE.Matrix4();
    private _basis = new THREE.Matrix4();
    private _position = new THREE.Vector3();
    private _quaternion = new THREE.Quaternion();
    private _scale = new THREE.Vector3();
    private _along = new THREE.Vector3();
    private _across = new THREE.Vector3();
    private _normal = new THREE.Vector3();

    constructor(scene: Scene) {
        this._scene = scene;
    }

    get enabled(): boolean { return cfg.lighting.bakedShadows.enabled; }

    /**
     * Declares a caster shape and returns the handle `add` takes. Call during
     * setup; the actual bake needs a renderer and happens in `bake`.
     */
    register(geometry: THREE.BufferGeometry | THREE.BufferGeometry[]): number {
        if (!this.enabled) return -1;
        this._pending.push(Array.isArray(geometry) ? geometry : [geometry]);
        return this._pending.length - 1;
    }

    /**
     * Bakes every registered shape. Must run once the renderer exists — the
     * silhouettes are render-target renders — and before the first frame.
     */
    bake(renderer: THREE.WebGLRenderer): void {
        if (!this.enabled || this._baked) return;
        this._baked = true;
        const s = cfg.lighting.bakedShadows;

        // Laid flat in XZ with local +Z as the down-light axis, so one basis
        // rotation aims and tilts it at once.
        //
        // The V FLIP matters and is easy to miss. PlaneGeometry puts v=1 at
        // y=+0.5, and rotateX(-90) maps (x,y,0) to (x,0,-y) — so v=1, which is
        // the TOP of the silhouette and therefore the far tip of the shadow, ends
        // up at local -Z while we aim +Z away from the light. Left alone the
        // shadow runs backwards: canopy at the trunk, trunk at the far end.
        // rotateX(+90) would fix the axis but point the quad's normal at the
        // ground, so flip the coordinate instead of the geometry.
        const quad = new THREE.PlaneGeometry(1, 1);
        quad.rotateX(-Math.PI / 2);
        const uv = quad.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
        uv.needsUpdate = true;

        for (const parts of this._pending) {
            const silhouette = bakeShadowSilhouette(renderer, parts, this._frame, s.textureSize);
            const material = new THREE.MeshBasicMaterial({
                map: silhouette.texture,
                transparent: true,
                opacity: s.opacity,
                depthWrite: false,
                // Fogged on purpose: a distant shadow fades toward the same colour
                // the ground under it fades to, instead of staying a dark patch.
                fog: true,
                // The decal sits centimetres above the surface it darkens, which
                // is a coplanar z-fight waiting to happen on a slope.
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -2,
            });
            const node = new Node();
            const mesh = node.addComponent(InstancedMesh3D);
            mesh.geometry = quad;
            mesh.material = material;
            mesh.count = s.maxInstances;
            this._scene.addChild(node);
            // Instances are spread far from the node's origin, so a bounding
            // sphere around it culls them wrongly. Same trap as the trees.
            mesh.object3D.frustumCulled = false;
            this._batches.push({ silhouette, mesh, count: 0 });
        }
        this._pending.length = 0;
    }

    /** Start a frame. Callers then `add` every caster, then `commit`. */
    begin(): void {
        for (const b of this._batches) b.count = 0;
    }

    /**
     * One caster instance.
     *
     * Positions are RENDER space — the same coordinates the caster's own mesh
     * uses — and `groundY` is the surface the shadow lands on, not the object's
     * origin. `nx/ny/nz` is the ground normal there; pass world up for the road.
     */
    add(
        handle: number,
        x: number, groundY: number, z: number,
        scale: number,
        nx = 0, ny = 1, nz = 0,
    ): void {
        const batch = this._batches[handle];
        if (!batch) return;
        const s = cfg.lighting.bakedShadows;
        if (batch.count >= s.maxInstances) return;

        const f = this._frame;
        const sil = batch.silhouette;
        // The projection: across the light maps 1:1, along it stretches by
        // 1/sin(elevation). See shadowSilhouette.ts.
        const stretch = 1 / f.sinElev;
        const along = sil.height * scale * stretch;
        const across = sil.width * scale;
        // Where the silhouette's centre lands, from the caster's origin.
        const offAlong = sil.offsetU * scale * stretch;
        const offAcross = sil.offsetR * scale;

        this._position.set(
            x + f.groundX * offAlong + f.R.x * offAcross,
            groundY + s.lift,
            z + f.groundZ * offAlong + f.R.z * offAcross,
        );

        // Tilt to the ground so the decal lies IN the surface rather than
        // through it: local +Y to the normal, local +Z to the down-light
        // direction projected into that plane.
        this._normal.set(nx, ny, nz).normalize();
        this._along.set(f.groundX, 0, f.groundZ)
            .addScaledVector(this._normal, -this._normal.dot(this._along.set(f.groundX, 0, f.groundZ)));
        if (this._along.lengthSq() < 1e-6) this._along.set(f.groundX, 0, f.groundZ);
        this._along.normalize();
        // cross(along, normal), NOT cross(normal, along). The latter comes out as
        // -R, which mirrors the silhouette left-right against the texture's u
        // axis. This order is still a proper right-handed basis, since
        // cross(across, normal) recovers `along`.
        this._across.crossVectors(this._along, this._normal).normalize();
        this._basis.makeBasis(this._across, this._normal, this._along);
        this._quaternion.setFromRotationMatrix(this._basis);

        this._scale.set(across, 1, along);
        this._matrix.compose(this._position, this._quaternion, this._scale);
        batch.mesh.object3D.setMatrixAt(batch.count++, this._matrix);
    }

    /** Publish the frame's instances. */
    commit(): void {
        for (const b of this._batches) {
            // `object3D.count` is the free per-frame dial. Assigning the
            // WRAPPER's `count` rebuilds the mesh and discards every matrix —
            // ARCHITECTURE.md section 3 item 4.
            b.mesh.object3D.count = b.count;
            b.mesh.object3D.instanceMatrix.needsUpdate = true;
        }
    }

    get liveCount(): number {
        let n = 0;
        for (const b of this._batches) n += b.count;
        return n;
    }
}
