import * as THREE from 'three';
import { Node, InstancedMesh3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { createTreeGeometry, createTreeMaterial } from '../procedural/tree';
import { heightAt, normalAt } from '../procedural/heightField';
import { roadCenterX } from './roadPath';
import { mulberry32, hashChunk } from '../procedural/random';
import type { WorldScroll } from './WorldScroll';

interface Placement {
    x: number;
    /** Absolute world Z. */
    z: number;
    y: number;
    rotationY: number;
    scale: number;
    variant: number;
}

const _normal = { x: 0, y: 1, z: 0 };

/**
 * ScatterStreamer — trees placed per terrain chunk and drawn instanced.
 *
 * The placement algorithm is ported from `Procedural_3D_world/src/scatter/
 * scatter.js`: a jittered grid of candidates, then rejection by slope, by a
 * low-frequency density mask (which is what makes clumps and clearings rather
 * than an even sprinkle), and by distance from the road — the original rejected
 * on distance from its river, which is the same test with a different centreline.
 *
 * Two changes from the original, both forced by this being infinite:
 *
 *  1. **Placement is per chunk, seeded from the chunk's own coordinates.** P3W
 *     sampled one jittered grid across a fixed world extent. Here a chunk is
 *     discarded and rebuilt whenever the window rolls past it, so its trees have
 *     to regenerate *identically* — hence a pure function of (cx, cz).
 *  2. **P3W's `placementsToMatrices` allocated a Matrix4 and a Vector3 per
 *     placement** (ARCHITECTURE.md §4.2). Matrices here are composed into
 *     scratch objects and written straight to the instance buffer.
 *
 * One InstancedMesh per variant, so the whole forest is `variants` draw calls in
 * the main pass and the same again in the shadow pass.
 */
export class ScatterStreamer {

    private _meshes: InstancedMesh3D[] = [];
    private _scroll: WorldScroll;
    /** Placements per live chunk, keyed the same way the terrain keys its own. */
    private _byChunk = new Map<number, Placement[]>();
    /** Reused per frame, one bucket per variant. */
    private _buckets: Placement[][] = [];

    private _matrix = new THREE.Matrix4();
    private _position = new THREE.Vector3();
    private _quaternion = new THREE.Quaternion();
    private _euler = new THREE.Euler();
    private _scaleVec = new THREE.Vector3();

    /** Diagnostics for the perf HUD. */
    get liveCount(): number {
        let n = 0;
        for (const list of this._byChunk.values()) n += list.length;
        return n;
    }

    constructor(scene: Scene, scroll: WorldScroll) {
        this._scroll = scroll;
        const material = createTreeMaterial();

        for (let v = 0; v < cfg.trees.variants; v++) {
            const node = new Node();
            const mesh = node.addComponent(InstancedMesh3D);
            // Variant seeds are fixed constants, not random: the same build must
            // produce the same forest every run.
            mesh.geometry = createTreeGeometry(0x7ee5 + v * 977);
            mesh.material = material;
            mesh.count = cfg.trees.maxPerVariant;
            mesh.castShadow = cfg.lighting.shadows.enabled;
            scene.addChild(node);
            // Instances sit far from the geometry's local origin, so the default
            // bounding sphere doesn't cover them and the batch would be culled
            // out of the shadow pass. See ARCHITECTURE.md §3 item 5.
            mesh.object3D.frustumCulled = false;
            mesh.object3D.count = 0;
            this._meshes.push(mesh);
            this._buckets.push([]);
        }
    }

    /**
     * Low-frequency mask that clumps trees. Same cheap multi-sine trick as the
     * height field, at a deliberately unrelated frequency so forests don't line
     * up with the terrain's own bumps.
     */
    private static _density(x: number, z: number): number {
        const f = cfg.trees.densityFrequency;
        const v = Math.sin(x * f) * Math.cos(z * f * 0.87)
            + 0.5 * Math.sin((x - z) * f * 1.9 + 4.1);
        return v / 1.5 * 0.5 + 0.5;      // → roughly 0…1
    }

    /** Generates one chunk's placements. Pure in (cx, cz). */
    private _placementsFor(cx: number, cz: number): Placement[] {
        const t = cfg.trees;
        const size = cfg.terrain.chunkSize;
        const rand = mulberry32(hashChunk(cx, cz, 0x7ee5));
        const out: Placement[] = [];

        for (let gz = 0; gz < size; gz += t.spacing) {
            for (let gx = 0; gx < size; gx += t.spacing) {
                // Jittered grid: direct control of average density without the
                // visible regularity of a plain grid or the clumping of pure
                // random placement.
                const x = cx * size + gx + t.spacing * (0.5 + (rand() - 0.5) * 0.8);
                const z = cz * size + gz + t.spacing * (0.5 + (rand() - 0.5) * 0.8);
                const variant = Math.floor(rand() * t.variants);
                const rotationY = rand() * Math.PI * 2;
                const scale = 0.8 + rand() * 0.45;

                if (Math.abs(x - roadCenterX(z)) < t.roadClearance) continue;
                if (ScatterStreamer._density(x, z) < t.densityCutoff) continue;

                normalAt(x, z, _normal);
                // normalY falls as the ground steepens; reject cliffs.
                if (_normal.y < 1 / Math.sqrt(1 + t.maxSlope * t.maxSlope)) continue;

                out.push({ x, z, y: heightAt(x, z) - t.sinkDepth, rotationY, scale, variant });
            }
        }
        return out;
    }

    /**
     * Rebuilds placements for the chunks currently live, then rewrites the
     * instance buffers.
     *
     * `liveKeys` comes from the terrain streamer so the two can never disagree
     * about which ground exists — a tree standing on a chunk that has been
     * recycled would float in mid-air.
     */
    update(liveKeys: Iterable<number>, chunkOf: (key: number) => { cx: number; cz: number }): void {
        // Drop chunks that are gone, add the ones that appeared. Placement
        // generation is the expensive part, so it happens once per chunk rather
        // than once per frame.
        // Trees use a SHORTER window than the terrain: the far chunks are 98%
        // fog-hidden, so scattering there costs triangles in both the main and
        // shadow pass to draw an invisible smudge. See `trees.maxChunksAhead`.
        const baseCz = Math.floor(this._scroll.travelled / cfg.terrain.chunkSize);
        const maxCz = baseCz + cfg.trees.maxChunksAhead;

        const seen = new Set<number>();
        for (const key of liveKeys) {
            const { cx, cz } = chunkOf(key);
            if (cz > maxCz) continue;
            seen.add(key);
            if (!this._byChunk.has(key)) {
                this._byChunk.set(key, this._placementsFor(cx, cz));
            }
        }
        for (const key of this._byChunk.keys()) {
            if (!seen.has(key)) this._byChunk.delete(key);
        }

        for (const bucket of this._buckets) bucket.length = 0;
        for (const list of this._byChunk.values()) {
            for (const p of list) {
                const bucket = this._buckets[p.variant];
                if (bucket.length < cfg.trees.maxPerVariant) bucket.push(p);
            }
        }

        const travelled = this._scroll.travelled;
        for (let v = 0; v < this._meshes.length; v++) {
            const mesh = this._meshes[v];
            const bucket = this._buckets[v];
            const obj = mesh.object3D;
            for (let i = 0; i < bucket.length; i++) {
                const p = bucket[i];
                this._position.set(p.x, p.y, travelled - p.z);
                this._euler.set(0, p.rotationY, 0);
                this._quaternion.setFromEuler(this._euler);
                this._scaleVec.setScalar(p.scale);
                this._matrix.compose(this._position, this._quaternion, this._scaleVec);
                obj.setMatrixAt(i, this._matrix);
            }
            // `object3D.count` is the free per-frame dial. Assigning the
            // WRAPPER's `count` would rebuild the InstancedMesh and discard
            // every matrix — ARCHITECTURE.md §3 item 4.
            obj.count = bucket.length;
            obj.instanceMatrix.needsUpdate = true;
        }
    }

    reset(): void {
        this._byChunk.clear();
    }
}
