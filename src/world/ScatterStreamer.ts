import * as THREE from 'three';
import { Node, InstancedMesh3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { createTreeGeometry, createTreeMaterial, type TreeVariant } from '../procedural/tree';
import { bakeTreeImpostor, impostorFrameSize } from '../procedural/treeImpostor';
import { heightAt, normalAt } from '../procedural/heightField';
import { roadCenterX } from './roadPath';
import { mulberry32, hashChunk } from '../procedural/random';
import type { WorldScroll } from './WorldScroll';
import type { TreeShadowMask } from './TreeShadowMask';

interface Placement {
    x: number;
    /** Absolute world Z. */
    z: number;
    y: number;
    rotationY: number;
    scale: number;
    variant: number;
}

/** A variant's mesh plus the billboard that stands in for it at distance. */
interface Variant {
    tree: TreeVariant;
    /** Edge length of the square the impostor was baked in, in world units. */
    frame: number;
    far: InstancedMesh3D;
    farBucket: Placement[];
    /** Scratch bucket built this frame, swapped with `farBucket` after sorting. */
    nextFarBucket: Placement[];
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
 * Two LOD tiers. Near trees are real geometry, one InstancedMesh per variant.
 * Past `trees.lodCrossover` a tree becomes a single billboard quad carrying a
 * baked image of a tree — the impostor technique open-world racers use for
 * vegetation, at 2 triangles against ~60.
 *
 * That tier is what lets trees reach the terrain's full draw edge. Before it,
 * trees stopped at ~200m because geometry all the way out was too expensive —
 * and fog still leaves ~8% of a tree's colour showing there, so they winked out
 * while faintly visible. Reaching 280m, where fog leaves 0.006%, makes the
 * window edge genuinely invisible without any fading trickery. (Both figures are
 * for the current `world.fogFalloff`; they were 14% and 2% at the old exponent
 * of 2, which is why the crossover was worth building.)
 */
export class ScatterStreamer {

    private _meshes: InstancedMesh3D[] = [];
    private _variants: Variant[] = [];
    private _baked = false;
    private _scroll: WorldScroll;
    /** Placements per live chunk, keyed the same way the terrain keys its own. */
    private _byChunk = new Map<number, Placement[]>();
    /** Reused per frame, one bucket per variant. */
    private _buckets: Placement[][] = [];
    /** Scratch buckets let us detect whether GPU instance membership changed. */
    private _nextBuckets: Placement[][] = [];
    /** Travel value at which the current instance matrices were written. */
    private _matrixAnchor = 0;

    private _matrix = new THREE.Matrix4();
    private _position = new THREE.Vector3();
    private _quaternion = new THREE.Quaternion();
    private _euler = new THREE.Euler();
    private _scaleVec = new THREE.Vector3();

    /** Diagnostics for the perf HUD: near geometry + far billboards. */
    private _treeMask: TreeShadowMask | null = null;
    private _maskHandles: number[] = [];

    /**
     * Wires up the top-down tree shadow mask. One silhouette per variant, so
     * each tree keeps its own trunk and canopy shape.
     */
    setTreeShadowMask(mask: TreeShadowMask | null): void {
        this._treeMask = mask;
        if (!mask) return;
        this._maskHandles = this._variants.map(v => mask.register(v.tree.geometry));
    }

    private _nearCount = 0;
    private _farCount = 0;

    /** Trees drawn as real geometry this frame. */
    get nearCount(): number { return this._nearCount; }
    /** Trees drawn as billboards this frame. */
    get farCount(): number { return this._farCount; }

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
            const variant = createTreeGeometry(0x7ee5 + v * 977);
            mesh.geometry = variant.geometry;
            mesh.material = material;
            mesh.count = cfg.trees.maxPerVariant;
            scene.addChild(node);
            // Instances sit far from the geometry's local origin, so the default
            // bounding sphere doesn't cover them and the batch would be culled
            // out of the shadow pass. See ARCHITECTURE.md §3 item 5.
            mesh.object3D.frustumCulled = false;
            mesh.object3D.count = 0;
            this._meshes.push(mesh);
            this._buckets.push([]);
            this._nextBuckets.push([]);

            // ── Distant tier for this variant ─────────────────────────────
            // One per variant, not one shared: each carries a baked image of
            // its OWN mesh, which is the whole point — the crossover then
            // changes triangle count and nothing else.
            //
            // No billboarding needed: the camera never yaws, so a quad facing
            // +Z always faces it.
            const farNode = new Node();
            const far = farNode.addComponent(InstancedMesh3D);
            far.geometry = new THREE.PlaneGeometry(1, 1);
            // Starts empty; the real texture is baked once the renderer exists.
            far.material = new THREE.MeshBasicMaterial({
                transparent: false, alphaTest: 0.5, visible: false,
            });
            far.count = cfg.trees.maxFarInstances;
            scene.addChild(farNode);
            far.object3D.frustumCulled = false;
            far.object3D.count = 0;

            this._variants.push({
                tree: variant,
                frame: impostorFrameSize(variant),
                far,
                farBucket: [],
                nextFarBucket: [],
            });
        }
    }

    /**
     * Bakes each variant's impostor. Must be called once the WebGL renderer
     * exists — the engine creates it lazily on the first frame, so the scene
     * calls this from `ThreeSceneSystem.onRendererReady`.
     *
     * Until it runs, the far tier's material is `visible: false`, so distant
     * trees are simply absent rather than drawn as untextured white rectangles.
     */
    bakeImpostors(renderer: THREE.WebGLRenderer): void {
        if (this._baked) return;
        this._baked = true;
        const nearMaterial = this._meshes[0].material as THREE.Material;
        for (const v of this._variants) {
            const texture = bakeTreeImpostor(
                renderer, v.tree, nearMaterial, cfg.trees.spriteTextureSize,
            );
            v.far.material = new THREE.MeshBasicMaterial({
                map: texture,
                // Cutout rather than blending: writes depth like opaque
                // geometry, so hundreds of quads need no back-to-front sorting.
                transparent: false,
                alphaTest: 0.5,
                fog: true,
            });
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
        const sizeX = cfg.terrain.chunkWidth, sizeZ = cfg.terrain.chunkLength;
        const rand = mulberry32(hashChunk(cx, cz, 0x7ee5));
        const out: Placement[] = [];

        for (let gz = 0; gz < sizeZ; gz += t.spacing) {
            for (let gx = 0; gx < sizeX; gx += t.spacing) {
                // Jittered grid: direct control of average density without the
                // visible regularity of a plain grid or the clumping of pure
                // random placement.
                const x = cx * sizeX + gx + t.spacing * (0.5 + (rand() - 0.5) * 0.8);
                const z = cz * sizeZ + gz + t.spacing * (0.5 + (rand() - 0.5) * 0.8);
                const variant = Math.floor(rand() * t.variants);
                const rotationY = rand() * Math.PI * 2;
                const scale = 0.8 + rand() * 0.45;

                if (Math.abs(x - roadCenterX(z)) < t.roadClearance) continue;
                if (ScatterStreamer._density(x, z) < t.densityCutoff) continue;

                normalAt(x, z, _normal);
                // normalY falls as the ground steepens; reject cliffs.
                if (_normal.y < 1 / Math.sqrt(1 + t.maxSlope * t.maxSlope)) continue;

                out.push({
                    x, z, y: heightAt(x, z) - t.sinkDepth, rotationY, scale, variant,
                });
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
        // `trees.maxChunksAhead` bounds the scatter window independently of the
        // terrain window. It currently matches it, because the far tier makes a
        // distant tree two triangles; it existed to stop geometry being spent on
        // fog-hidden smudges, which is only a concern if the crossover moves out
        // far enough that far chunks hold real geometry again.
        const baseCz = Math.floor(this._scroll.travelled / cfg.terrain.chunkLength);
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

        // Sort placements into the near tier (real geometry, per variant) and the
        // far tier (billboards, all variants together) by distance ahead.
        const travelled = this._scroll.travelled;
        const crossover = cfg.trees.lodCrossover;
        // Compared squared, so the split costs no sqrt per tree.
        const crossoverSq = crossover * crossover;
        // Lateral reference for the viewer. The camera never strays further than
        // the road's half-width from its centre, which is noise against a ~140m
        // threshold, and taking it from the road keeps this out of the camera's
        // render-space coordinates entirely.
        const viewerX = roadCenterX(travelled);

        for (const bucket of this._nextBuckets) bucket.length = 0;
        for (const v of this._variants) v.nextFarBucket.length = 0;
        let near = 0, far = 0;
        for (const list of this._byChunk.values()) {
            for (const p of list) {
                const farBucket = this._variants[p.variant].nextFarBucket;
                // TRUE distance, not depth ahead. What decides whether the swap
                // is visible is the tree's angular size, i.e. height/distance —
                // so `lodCrossover` should mean the same thing for a tree off to
                // the side as for one straight ahead. Depth-ahead also handed
                // geometry to trees far out to the left and right that are
                // outside the ~38 degree horizontal FOV entirely.
                const dx = p.x - viewerX;
                const dz = p.z - travelled;
                if (dx * dx + dz * dz < crossoverSq) {
                    const bucket = this._nextBuckets[p.variant];
                    if (bucket.length < cfg.trees.maxPerVariant) {
                        bucket.push(p);
                        near++;
                        continue;
                    }
                    // Near tier full: DEMOTE to a billboard rather than drop the
                    // tree. Dropping made `lodCrossover` non-monotone to tune —
                    // raising it past what `maxPerVariant` holds deleted trees
                    // instead of promoting them, so the knob got WORSE as you
                    // turned it up. Watch `near` in the perf HUD against
                    // maxPerVariant x variants to see if this is engaging.
                }
                if (farBucket.length < cfg.trees.maxFarInstances) {
                    farBucket.push(p);
                    far++;
                }
            }
        }
        this._nearCount = near;
        this._farCount = far;

        // Compare by placement identity and order. When both are unchanged the
        // existing GPU buffers are already exact; every tree only needs the one
        // shared Z translation applied below. Swap the arrays regardless so the
        // freshly classified set becomes authoritative for shadows and stats.
        let membershipChanged = false;
        for (let v = 0; v < this._buckets.length; v++) {
            if (!ScatterStreamer._samePlacements(this._buckets[v], this._nextBuckets[v])
                || !ScatterStreamer._samePlacements(
                    this._variants[v].farBucket,
                    this._variants[v].nextFarBucket,
                )) membershipChanged = true;
        }
        const previousBuckets = this._buckets;
        this._buckets = this._nextBuckets;
        this._nextBuckets = previousBuckets;
        for (const variant of this._variants) {
            const previous = variant.farBucket;
            variant.farBucket = variant.nextFarBucket;
            variant.nextFarBucket = previous;
        }

        // Tree shadows into the mask, from the NEAR buckets only — for the same
        // reason as the decals: the far tier is billboards, and a shadow 200m out
        // is behind 92% fog.
        //
        // Further limited to the roadside treeline: `maxRoadDistance` from
        // `roadCenterX` at the TREE's own z (the road curves, so this is not the
        // viewer's road position) — trees back in the background scatter never
        // throw a shadow onto ground the camera can see, so they're skipped
        // before `add`'s per-instance vector math rather than after.
        if (this._treeMask) {
            const maxRoadDistance = cfg.lighting.treeShadows.maxRoadDistance;
            for (let v = 0; v < this._buckets.length; v++) {
                const handle = this._maskHandles[v];
                for (const p of this._buckets[v]) {
                    if (Math.abs(p.x - roadCenterX(p.z)) > maxRoadDistance) continue;
                    this._treeMask.add(
                        handle,
                        p.x,
                        // `p.y` is the surface MINUS `trees.sinkDepth`; adding it
                        // back recovers the real ground. Unused by the mask,
                        // which has no height axis, but kept so the two paths
                        // cannot drift apart.
                        p.y + cfg.trees.sinkDepth,
                        travelled - p.z,
                        p.scale,
                    );
                }
            }
        }

        if (membershipChanged) this._writeMatrices(travelled);
        else this._scrollBatches(travelled - this._matrixAnchor);
    }

    reset(): void {
        this._byChunk.clear();
    }

    /** True when two LOD buckets contain the same placements in the same order. */
    private static _samePlacements(a: Placement[], b: Placement[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /**
     * Rewrites instance matrices only when chunk/LOD membership changed.
     * Matrices are anchored to the current travelled value to keep coordinates
     * small over an infinite run; subsequent frames move each whole batch.
     */
    private _writeMatrices(travelled: number): void {
        this._matrixAnchor = travelled;
        for (let v = 0; v < this._meshes.length; v++) {
            const bucket = this._buckets[v];
            const obj = this._meshes[v].object3D;
            obj.position.z = 0;
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

        // Billboards use the same anchor. Their quad is sized to the square
        // frame used by the impostor bake, so the LOD switch changes only tris.
        this._quaternion.identity();
        for (const variant of this._variants) {
            const obj = variant.far.object3D;
            obj.position.z = 0;
            for (let i = 0; i < variant.farBucket.length; i++) {
                const p = variant.farBucket[i];
                const frame = variant.frame * p.scale;
                this._position.set(
                    p.x,
                    p.y + variant.tree.height * 0.5 * p.scale,
                    travelled - p.z,
                );
                this._scaleVec.set(frame, frame, 1);
                this._matrix.compose(this._position, this._quaternion, this._scaleVec);
                obj.setMatrixAt(i, this._matrix);
            }
            obj.count = variant.farBucket.length;
            obj.instanceMatrix.needsUpdate = true;
        }
    }

    /** Moves every tree by one shared transform without touching GPU buffers. */
    private _scrollBatches(renderZ: number): void {
        for (const mesh of this._meshes) mesh.object3D.position.z = renderZ;
        for (const variant of this._variants) variant.far.object3D.position.z = renderZ;
    }
}
