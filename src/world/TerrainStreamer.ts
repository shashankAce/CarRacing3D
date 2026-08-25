import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { chunkVertexCount, buildChunkIndices, fillChunkBuffers } from '../procedural/chunkMesh';
import type { WorldScroll } from './WorldScroll';

interface ChunkSlot {
    mesh: THREE.Mesh;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    /** Grid coords this slot currently holds, or null when free. */
    cx: number;
    cz: number;
    inUse: boolean;
    /** False while queued but not yet filled — the mesh stays hidden. */
    ready: boolean;
}

/**
 * TerrainStreamer — a rolling window of terrain chunks around the car.
 *
 * Two things make this cheap enough to run forever:
 *
 *  1. **A fixed slot pool.** The window size is known from config, so every
 *     chunk's buffers, geometry and mesh are allocated once at startup and
 *     recycled by rewriting their contents. No geometry is ever created or
 *     disposed while driving, and the index buffer is shared by all of them
 *     since every chunk has identical topology.
 *  2. **A build queue capped at `maxBuildsPerFrame`.** Filling a chunk is the
 *     most expensive single operation in the game (ARCHITECTURE.md §5.3), so
 *     several arriving in one frame would show as a hitch. They're built
 *     nearest-first over successive frames instead; a not-yet-built chunk is
 *     simply invisible, which the fog hides.
 *
 * Chunks are only recycled in Z. World X doesn't scroll, so the lateral columns
 * are fixed for the whole run.
 */
export class TerrainStreamer {

    private _slots: ChunkSlot[] = [];
    private _byKey = new Map<number, ChunkSlot>();
    private _queue: ChunkSlot[] = [];
    private _scroll: WorldScroll;
    private _minCx: number;
    private _maxCx: number;
    /** Last window centre, so the window is only recomputed when it moves. */
    private _lastBaseCz = Number.NaN;

    // ── Diagnostics, read by PerfHud ──────────────────────────────────────
    /** Cost of the most recent single chunk build, ms. */
    lastBuildMs = 0;
    /** Worst single chunk build since `resetPeak()`. */
    peakBuildMs = 0;
    /** Worst single chunk build since the run started — the hitch to hunt. */
    allTimePeakBuildMs = 0;
    /** Total chunks built, for a builds-per-second rate. */
    buildCount = 0;
    /**
     * Time spent building the opening window, ms. This is LOAD time, not a
     * frame cost — it happens before the first frame is drawn — so it is kept
     * out of the peaks above, which exist to find dropped frames. Pooling the
     * two is misleading: the opening burst runs cold (interpreted, no JIT
     * warmup, first touch of every buffer) and its slowest chunk was reading
     * ~20x the steady-state figure while the game was in fact running at 60fps.
     */
    initialBuildMs = 0;

    /** False during the opening burst, so load-time builds don't pollute the peaks. */
    private _recordStats = true;

    get pendingBuilds(): number { return this._queue.length; }
    get residentChunks(): number { return this._byKey.size; }

    /** Clears the rolling peak so it tracks the recent worst, not the startup burst. */
    resetPeak(): void { this.peakBuildMs = 0; }

    constructor(scene: THREE.Scene, scroll: WorldScroll) {
        this._scroll = scroll;

        const t = cfg.terrain;
        const res = t.resolution;
        const vertexCount = chunkVertexCount(res);
        const indices = buildChunkIndices(res);
        const indexAttribute = new THREE.BufferAttribute(indices, 1);

        // Colour comes entirely from the baked per-vertex attribute, so the
        // base colour stays white — anything else would tint it.
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.94,
            metalness: 0.0,
        });

        // Lateral columns are centred on the road, biased so an even count
        // straddles x=0 rather than sitting off to one side.
        this._minCx = -Math.floor(t.chunksWide / 2);
        this._maxCx = this._minCx + t.chunksWide - 1;

        const depth = t.chunksAhead + t.chunksBehind + 1;
        const slotCount = t.chunksWide * depth;

        // A generous fixed bounding sphere: local geometry never changes shape,
        // only heights, so one safe overestimate avoids ever recomputing it.
        // Overestimating only costs a little missed culling; underestimating
        // makes chunks vanish at the edge of frame.
        const size = t.chunkSize;
        const radius = Math.hypot(size, size) * 0.5 + t.skirtDepth
            + t.amplitude * 2 + Math.abs(cfg.road.slopeAmplitude);
        const boundingSphere = new THREE.Sphere(new THREE.Vector3(size / 2, 0, -size / 2), radius);

        for (let i = 0; i < slotCount; i++) {
            const positions = new Float32Array(vertexCount * 3);
            const normals = new Float32Array(vertexCount * 3);
            const uvs = new Float32Array(vertexCount * 2);
            const colors = new Float32Array(vertexCount * 3);

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geometry.setIndex(indexAttribute);
            geometry.boundingSphere = boundingSphere;

            const mesh = new THREE.Mesh(geometry, material);
            mesh.visible = false;
            scene.add(mesh);

            this._slots.push({ mesh, positions, normals, uvs, colors, cx: 0, cz: 0, inUse: false, ready: false });
        }
    }

    /** Chunk grid coords → a single integer map key. */
    private static _key(cx: number, cz: number): number {
        // cz is unbounded over a long run; cx is a handful of values. Packing cx
        // into the low bits keeps the key a small integer (fast Map hashing)
        // without ever colliding.
        return cz * 64 + (cx + 32);
    }

    /**
     * Called every frame. Repositions live chunks against the current scroll,
     * retargets the window when the car crosses a chunk boundary, and drains up
     * to `maxBuildsPerFrame` from the build queue.
     */
    update(): void {
        const t = cfg.terrain;
        const size = t.chunkSize;
        const baseCz = Math.floor(this._scroll.travelled / size);

        if (baseCz !== this._lastBaseCz) {
            this._lastBaseCz = baseCz;
            this._retargetWindow(baseCz);
        }

        this._drainQueue();

        // Every live chunk slides with the scroll. This is the only per-frame
        // cost of the whole terrain — one subtraction per chunk.
        const travelled = this._scroll.travelled;
        for (const slot of this._slots) {
            if (!slot.inUse || !slot.ready) continue;
            slot.mesh.position.z = travelled - slot.cz * size;
        }
    }

    /** Releases chunks that fell outside the window and claims slots for new ones. */
    private _retargetWindow(baseCz: number): void {
        const t = cfg.terrain;
        const minCz = baseCz - t.chunksBehind;
        const maxCz = baseCz + t.chunksAhead;

        // Release anything now out of range.
        for (const slot of this._slots) {
            if (!slot.inUse) continue;
            if (slot.cz < minCz || slot.cz > maxCz) {
                this._byKey.delete(TerrainStreamer._key(slot.cx, slot.cz));
                slot.inUse = false;
                slot.ready = false;
                slot.mesh.visible = false;
            }
        }

        // A released slot may still be sitting in the queue from a previous
        // frame; drop those rather than building a chunk nobody wants.
        this._queue = this._queue.filter(s => s.inUse);

        // Claim slots for everything in range that isn't live yet, nearest
        // first — the chunk about to come into view matters more than the one
        // at the far edge of the fog.
        for (let cz = maxCz; cz >= minCz; cz--) {
            for (let cx = this._minCx; cx <= this._maxCx; cx++) {
                const key = TerrainStreamer._key(cx, cz);
                if (this._byKey.has(key)) continue;
                const slot = this._slots.find(s => !s.inUse);
                if (!slot) return;   // pool exhausted — should not happen, window is sized from config
                slot.cx = cx;
                slot.cz = cz;
                slot.inUse = true;
                slot.ready = false;
                slot.mesh.visible = false;
                slot.mesh.position.x = cx * cfg.terrain.chunkSize;
                this._byKey.set(key, slot);
                this._queue.push(slot);
            }
        }
        // Nearest-to-the-car first.
        this._queue.sort((a, b) => Math.abs(a.cz - baseCz) - Math.abs(b.cz - baseCz));
    }

    private _drainQueue(): void {
        const limit = cfg.terrain.maxBuildsPerFrame;
        if (this._queue.length === 0) return;

        for (let n = 0; n < limit; n++) {
            const slot = this._queue.shift();
            if (!slot) break;
            if (!slot.inUse) { n--; continue; }   // released while queued
            this._build(slot);
        }
    }

    private _build(slot: ChunkSlot): void {
        // Timed per chunk, not per drain loop: the per-chunk number is the one
        // that has to fit in a frame, and it's what `maxBuildsPerFrame` bounds.
        const started = performance.now();
        fillChunkBuffers(
            slot.cx, slot.cz, cfg.terrain.resolution,
            slot.positions, slot.normals, slot.uvs, slot.colors,
        );
        const geometry = slot.mesh.geometry;
        (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

        slot.mesh.position.z = this._scroll.travelled - slot.cz * cfg.terrain.chunkSize;
        slot.ready = true;
        slot.mesh.visible = true;

        const elapsed = performance.now() - started;
        this.buildCount++;
        if (!this._recordStats) return;
        this.lastBuildMs = elapsed;
        if (elapsed > this.peakBuildMs) this.peakBuildMs = elapsed;
        if (elapsed > this.allTimePeakBuildMs) this.allTimePeakBuildMs = elapsed;
    }

    /**
     * Forces the whole window to be built immediately, ignoring the per-frame
     * cap. For scene start and restart only — the player must never see the
     * world assembling itself.
     */
    buildAllNow(): void {
        this._recordStats = false;
        const started = performance.now();

        this._lastBaseCz = Number.NaN;
        this.update();
        while (this._queue.length > 0) {
            const slot = this._queue.shift();
            if (slot?.inUse) this._build(slot);
        }

        this.initialBuildMs = performance.now() - started;
        this._recordStats = true;
    }
}
