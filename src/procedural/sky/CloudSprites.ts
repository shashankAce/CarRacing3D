import * as THREE from 'three';
import { gameConfig as cfg } from '../../config/gameConfig';
import { dayFactor } from './SkyDome';
import { createCloudSpriteTexture } from './cloudTexture';
import { mulberry32 } from '../random';

/**
 * CloudSprites — baked cloud puffs on quads, drifting across the forward sky.
 *
 * Replaces the sky shader's per-pixel noise clouds, which measured ~7.7ms a
 * frame (≈14ms on a low-end phone). The saving is structural: noise clouds paid
 * for every pixel of the upper sky whether a cloud was there or not, while these
 * pay only for the pixels they cover, at one texture fetch each.
 *
 * Two things fall out of the camera never yawing or re-pitching, which is a
 * gameplay requirement rather than an accident:
 *
 *  1. **No billboarding.** A quad facing +Z always faces this camera, so there's
 *     no per-frame orientation work and no need for THREE.Sprite.
 *  2. **Clouds only need to exist in the forward arc.** The visible sky is a
 *     fixed window — elevation ~6..25°, azimuth ±21° — so scattering over the
 *     whole celestial sphere is wasted. A first attempt did exactly that and put
 *     roughly 1.6 of 14 sprites inside the horizontal cone and none inside the
 *     elevation band, i.e. an empty sky.
 *
 * Together those let the whole layer be one InstancedMesh per texture variant —
 * three draw calls rather than one per cloud.
 *
 * Draw order is load-bearing. The sky dome draws LAST (renderOrder 1000),
 * depth-tested and without writing depth, so anything drawn before it that also
 * skips depth write gets painted over. These sit at 1001: after the dome so
 * they're visible, still depth-tested so hills correctly occlude them.
 */
export class CloudSprites {

    private _group = new THREE.Group();
    private _meshes: THREE.InstancedMesh[] = [];
    /** Per-instance base azimuth and elevation, grouped by variant. */
    private _placements: Array<Array<{ azimuth: number; elevation: number; w: number; h: number }>> = [];
    private _drift = 0;

    private _matrix = new THREE.Matrix4();
    private _position = new THREE.Vector3();
    private _quaternion = new THREE.Quaternion();
    private _scale = new THREE.Vector3();

    constructor(scene: THREE.Scene) {
        const c = cfg.sky.clouds;
        const rand = mulberry32(c.seed);

        // Bucket placements by variant first, so each InstancedMesh knows its
        // own count before it's created — the wrapper-free THREE.InstancedMesh
        // still needs its capacity up front.
        for (let v = 0; v < c.variants; v++) this._placements.push([]);
        for (let i = 0; i < c.count; i++) {
            const variant = Math.floor(rand() * c.variants);
            const w = c.sizeMin + rand() * (c.sizeMax - c.sizeMin);
            this._placements[variant].push({
                // Spread across the visible arc, plus a margin either side so
                // clouds drift IN rather than popping into existence.
                azimuth: (rand() - 0.5) * 2 * c.arcDegrees * Math.PI / 180,
                elevation: (c.minElevation + rand() * (c.maxElevation - c.minElevation)) * Math.PI / 180,
                w,
                h: w * (0.4 + rand() * 0.2),
            });
        }

        const geometry = new THREE.PlaneGeometry(1, 1);
        for (let v = 0; v < c.variants; v++) {
            const list = this._placements[v];
            if (list.length === 0) { this._meshes.push(null as any); continue; }

            const material = new THREE.MeshBasicMaterial({
                map: createCloudSpriteTexture(c.textureSize, c.seed + v * 313),
                transparent: true,
                depthWrite: false,
                opacity: c.opacity,
                // Tinted by how high the sun is. Unlit geometry gets no lighting
                // for free, so without this the clouds stayed pure white at
                // sunset and only looked warm where the orange sky showed
                // through their 20% transparency — which reads as clouds sitting
                // in FRONT of the time of day rather than being part of it.
                // THREE.Color.lerp works in linear space, matching how the dome
                // blends its own horizon and zenith off the same sunHeight().
                color: new THREE.Color(c.lowColor).lerp(new THREE.Color(c.color), dayFactor()),
                // Unlit on purpose: these read as distant sky, and lighting them
                // would tie their brightness to the shadow-casting sun for no
                // visual gain. Fog off for the same reason — they're meant to be
                // beyond any fog distance.
                fog: false,
            });
            const mesh = new THREE.InstancedMesh(geometry, material, list.length);
            mesh.renderOrder = 1001;
            // Instances sit far from the geometry's origin and the group moves
            // with the camera every frame; culling it would only ever be wrong.
            mesh.frustumCulled = false;
            this._meshes.push(mesh);
            this._group.add(mesh);
        }

        scene.add(this._group);
        this._writeMatrices();
    }

    /**
     * Pins the layer to the camera, and drifts it if drift is enabled.
     *
     * With `driftSpeed` at zero the matrices are already correct from the
     * constructor, so this skips rewriting them — clouds at this distance have
     * no perceptible parallax against a car, so there is nothing to recompute.
     */
    update(dt: number, cameraPosition: THREE.Vector3): void {
        this._group.position.copy(cameraPosition);
        if (cfg.sky.clouds.driftSpeed === 0) return;
        this._drift += dt * cfg.sky.clouds.driftSpeed;
        this._writeMatrices();
    }

    /**
     * Positions every instance for the current drift.
     *
     * Drift moves clouds in AZIMUTH and wraps them within the arc, rather than
     * yawing the whole layer. Yawing a 360° layer was the obvious approach and
     * is wrong here: with clouds only in the forward arc, a rotation would empty
     * the sky and never refill it.
     */
    private _writeMatrices(): void {
        const c = cfg.sky.clouds;
        const arc = c.arcDegrees * Math.PI / 180;
        const span = arc * 2;

        for (let v = 0; v < this._meshes.length; v++) {
            const mesh = this._meshes[v];
            if (!mesh) continue;
            const list = this._placements[v];
            for (let i = 0; i < list.length; i++) {
                const p = list[i];
                // Wrap into [-arc, +arc] so a cloud leaving one edge re-enters
                // at the other.
                let az = (p.azimuth + this._drift + arc) % span;
                if (az < 0) az += span;
                az -= arc;

                const r = c.radius;
                const cosEl = Math.cos(p.elevation);
                // Forward is -Z, so the arc is measured around -Z rather than +X.
                this._position.set(
                    Math.sin(az) * cosEl * r,
                    Math.sin(p.elevation) * r,
                    -Math.cos(az) * cosEl * r,
                );
                this._scale.set(p.w, p.h, 1);
                this._matrix.compose(this._position, this._quaternion, this._scale);
                mesh.setMatrixAt(i, this._matrix);
            }
            mesh.instanceMatrix.needsUpdate = true;
        }
    }
}
