import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadLevelAt } from './roadPath';
import type { WorldScroll } from './WorldScroll';

interface BandSlot {
    mesh: THREE.Mesh;
    positions: Float32Array;
    bi: number;
    inUse: boolean;
}

/** Lateral strips across the road: left line, asphalt, right line. */
const STRIP_COUNT = 3;

/**
 * RoadMesh — the asphalt ribbon, streamed in bands.
 *
 * The road surface can't be one long static quad, because the run is infinite.
 * It also can't be baked into the terrain chunks: at 40m chunks and 17
 * vertices a side, terrain vertex spacing is 2.5m, far too coarse to give the
 * road a crisp edge. So it's its own recycled ribbon, sitting a couple of
 * centimetres above the flat corridor the height field carves for it.
 *
 * Each band is three lateral strips — edge line, asphalt, edge line — in one
 * geometry with per-vertex colour, so a band is a single draw call and the
 * painted edges stay pixel-crisp regardless of terrain resolution. Every row of
 * vertices takes its x from `roadCenterX(worldZ)`, so a curving road needs no
 * code change here at all, only a non-zero `road.curveAmplitude`.
 *
 * Unlike the terrain, bands are built immediately on claim rather than queued:
 * a band is ~30 vertices of straight arithmetic with no height-field sampling,
 * against a terrain chunk's ~350 vertices each sampling the field five times.
 * There is nothing here worth amortising.
 */
export class RoadMesh {

    private _slots: BandSlot[] = [];
    private _live = new Map<number, BandSlot>();
    private _scroll: WorldScroll;
    private _lastBaseBi = Number.NaN;

    constructor(scene: THREE.Scene, scroll: WorldScroll) {
        this._scroll = scroll;

        const rs = cfg.roadSurface;
        const rows = rs.segmentsPerBand + 1;
        const vertexCount = STRIP_COUNT * rows * 2;

        const indices: number[] = [];
        for (let s = 0; s < STRIP_COUNT; s++) {
            const base = s * rows * 2;
            for (let j = 0; j < rs.segmentsPerBand; j++) {
                const a = base + j * 2, b = a + 1, c = a + 2, d = a + 3;
                // Same winding reversal as the terrain grid — local Z is
                // mirrored (0 → -length) because forward is -Z.
                indices.push(a, b, c, b, d, c);
            }
        }
        const indexAttribute = new THREE.BufferAttribute(new Uint16Array(indices), 1);

        // Normals and colours are the same for every band and never change, so
        // they're filled once here and shared by every slot.
        const normals = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) normals[i * 3 + 1] = 1;
        const normalAttribute = new THREE.BufferAttribute(normals, 3);

        const colors = new Float32Array(vertexCount * 3);
        const line = new THREE.Color(cfg.colors.roadLine);
        const asphalt = new THREE.Color(cfg.colors.road);
        for (let s = 0; s < STRIP_COUNT; s++) {
            const c = s === 1 ? asphalt : line;
            for (let v = 0; v < rows * 2; v++) {
                const i = (s * rows * 2 + v) * 3;
                colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
            }
        }
        const colorAttribute = new THREE.BufferAttribute(colors, 3);

        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.88,
        });

        // Generous fixed bound — local geometry is a flat ribbon of known extent.
        // Generous fixed bound. It has to cover the band's lateral sway AND its
        // vertical travel, since positions are absolute in local space — an
        // under-sized sphere makes bands vanish at the edge of frame.
        const halfLen = rs.bandLength / 2;
        const bound = new THREE.Sphere(
            new THREE.Vector3(0, 0, -halfLen),
            Math.hypot(
                cfg.road.halfWidth + Math.abs(cfg.road.curveAmplitude),
                halfLen,
            ) + Math.abs(cfg.road.slopeAmplitude) + 1,
        );

        const slotCount = rs.bandsAhead + rs.bandsBehind + 1;
        for (let i = 0; i < slotCount; i++) {
            const positions = new Float32Array(vertexCount * 3);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('normal', normalAttribute);
            geometry.setAttribute('color', colorAttribute);
            geometry.setIndex(indexAttribute);
            geometry.boundingSphere = bound;

            const mesh = new THREE.Mesh(geometry, material);
            mesh.visible = false;
            scene.add(mesh);
            this._slots.push({ mesh, positions, bi: 0, inUse: false });
        }
    }

    update(): void {
        const rs = cfg.roadSurface;
        const baseBi = Math.floor(this._scroll.travelled / rs.bandLength);

        if (baseBi !== this._lastBaseBi) {
            this._lastBaseBi = baseBi;
            const minBi = baseBi - rs.bandsBehind;
            const maxBi = baseBi + rs.bandsAhead;

            for (const slot of this._slots) {
                if (slot.inUse && (slot.bi < minBi || slot.bi > maxBi)) {
                    this._live.delete(slot.bi);
                    slot.inUse = false;
                    slot.mesh.visible = false;
                }
            }
            for (let bi = minBi; bi <= maxBi; bi++) {
                if (this._live.has(bi)) continue;
                const slot = this._slots.find(s => !s.inUse);
                if (!slot) break;
                slot.bi = bi;
                slot.inUse = true;
                this._live.set(bi, slot);
                this._fill(slot);
                slot.mesh.visible = true;
            }
        }

        const travelled = this._scroll.travelled;
        for (const slot of this._slots) {
            if (slot.inUse) slot.mesh.position.z = travelled - slot.bi * rs.bandLength;
        }
    }

    private _fill(slot: BandSlot): void {
        const rs = cfg.roadSurface;
        const hw = cfg.road.halfWidth;
        const lw = cfg.road.lineWidth;
        const rows = rs.segmentsPerBand + 1;
        const originZ = slot.bi * rs.bandLength;

        // Lateral bounds of each strip, as offsets from the road centre.
        const edges: Array<[number, number]> = [
            [-hw, -hw + lw],
            [-hw + lw, hw - lw],
            [hw - lw, hw],
        ];

        let p = 0;
        for (let s = 0; s < STRIP_COUNT; s++) {
            const [left, right] = edges[s];
            for (let j = 0; j < rows; j++) {
                const localZ = (j / rs.segmentsPerBand) * rs.bandLength;
                const worldZ = originZ + localZ;
                const centre = roadCenterX(worldZ);
                const y = roadLevelAt(worldZ) + rs.lift;
                slot.positions[p++] = centre + left;  slot.positions[p++] = y; slot.positions[p++] = -localZ;
                slot.positions[p++] = centre + right; slot.positions[p++] = y; slot.positions[p++] = -localZ;
            }
        }
        (slot.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        slot.mesh.position.z = this._scroll.travelled - originZ;
    }
}
