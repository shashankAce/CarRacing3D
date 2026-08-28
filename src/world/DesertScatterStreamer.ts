import * as THREE from 'three';
import { InstancedMesh3D, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { createDesertProp, createDesertPropMaterial, type DesertPropVariant } from '../procedural/desertProp';
import { heightAt, normalAt } from '../procedural/heightField';
import { hashChunk, mulberry32 } from '../procedural/random';
import { roadCenterX } from './roadPath';
import type { WorldScroll } from './WorldScroll';
import type { TreeShadowMask } from './TreeShadowMask';

interface Placement {
    x: number;
    y: number;
    z: number;
    rotationY: number;
    scale: number;
    variant: number;
}

const _normal = { x: 0, y: 1, z: 0 };

/** Sparse, deterministic cactus-and-rock scenery for the desert biome. */
export class DesertScatterStreamer {
    private _meshes: InstancedMesh3D[] = [];
    private _variants: DesertPropVariant[] = [];
    private _handles: number[] = [];
    private _byChunk = new Map<number, Placement[]>();
    private _buckets: Placement[][] = [];
    private _scroll: WorldScroll;
    private _treeMask: TreeShadowMask | null = null;
    private _matrixAnchor = 0;
    private _matrix = new THREE.Matrix4();
    private _position = new THREE.Vector3();
    private _quaternion = new THREE.Quaternion();
    private _scale = new THREE.Vector3();

    get liveCount(): number {
        let count = 0;
        for (const placements of this._byChunk.values()) count += placements.length;
        return count;
    }
    get nearCount(): number { return this.liveCount; }
    get farCount(): number { return 0; }

    constructor(scene: Scene, scroll: WorldScroll) {
        this._scroll = scroll;
        const material = createDesertPropMaterial();
        for (let i = 0; i < cfg.desertProps.variants; i++) {
            const variant = createDesertProp(0xd35e7 + i * 811, i);
            const node = new Node();
            const mesh = node.addComponent(InstancedMesh3D);
            mesh.geometry = variant.geometry;
            mesh.material = material;
            mesh.count = cfg.desertProps.maxPerVariant;
            scene.addChild(node);
            mesh.object3D.frustumCulled = false;
            mesh.object3D.count = 0;
            this._variants.push(variant);
            this._meshes.push(mesh);
            this._buckets.push([]);
        }
    }

    setTreeShadowMask(mask: TreeShadowMask | null): void {
        this._treeMask = mask;
        if (mask) this._handles = this._variants.map(v => mask.register(v.geometry));
    }

    setVisible(visible: boolean): void {
        for (const mesh of this._meshes) mesh.object3D.visible = visible;
    }

    reset(): void {
        this._byChunk.clear();
    }

    private static _density(x: number, z: number): number {
        const f = cfg.desertProps.densityFrequency;
        const value = Math.sin(x * f + 2.7) * Math.cos(z * f * 0.91)
            + 0.45 * Math.sin((x + z) * f * 1.8);
        return value / 1.45 * 0.5 + 0.5;
    }

    private _placementsFor(cx: number, cz: number): Placement[] {
        const c = cfg.desertProps;
        const sizeX = cfg.terrain.chunkWidth;
        const sizeZ = cfg.terrain.chunkLength;
        const rand = mulberry32(hashChunk(cx, cz, 0xd35e7));
        const placements: Placement[] = [];
        const minNormalY = 1 / Math.sqrt(1 + c.maxSlope * c.maxSlope);

        for (let gz = 0; gz < sizeZ; gz += c.spacing) {
            for (let gx = 0; gx < sizeX; gx += c.spacing) {
                const x = cx * sizeX + gx + c.spacing * (0.5 + (rand() - 0.5) * 0.8);
                const z = cz * sizeZ + gz + c.spacing * (0.5 + (rand() - 0.5) * 0.8);
                const variant = Math.floor(rand() * c.variants);
                if (Math.abs(x - roadCenterX(z)) < c.roadClearance) continue;
                if (DesertScatterStreamer._density(x, z) < c.densityCutoff) continue;
                normalAt(x, z, _normal);
                if (_normal.y < minNormalY) continue;
                const rock = this._variants[variant].rock;
                placements.push({
                    x,
                    y: heightAt(x, z) - c.sinkDepth,
                    z,
                    rotationY: rand() * Math.PI * 2,
                    scale: rock ? 0.65 + rand() * 0.9 : 0.72 + rand() * 0.42,
                    variant,
                });
            }
        }
        return placements;
    }

    update(liveKeys: Iterable<number>, chunkOf: (key: number) => { cx: number; cz: number }): void {
        const baseCz = Math.floor(this._scroll.travelled / cfg.terrain.chunkLength);
        const seen = new Set<number>();
        let changed = false;
        for (const key of liveKeys) {
            const { cx, cz } = chunkOf(key);
            if (cz > baseCz + cfg.desertProps.maxChunksAhead) continue;
            seen.add(key);
            if (!this._byChunk.has(key)) {
                this._byChunk.set(key, this._placementsFor(cx, cz));
                changed = true;
            }
        }
        for (const key of this._byChunk.keys()) {
            if (!seen.has(key)) {
                this._byChunk.delete(key);
                changed = true;
            }
        }

        if (changed) this._writeMatrices();
        else this._scrollMeshes();
        this._submitShadows();
    }

    private _writeMatrices(): void {
        for (const bucket of this._buckets) bucket.length = 0;
        for (const list of this._byChunk.values()) {
            for (const placement of list) {
                const bucket = this._buckets[placement.variant];
                if (bucket.length < cfg.desertProps.maxPerVariant) bucket.push(placement);
            }
        }

        this._matrixAnchor = this._scroll.travelled;
        for (let v = 0; v < this._meshes.length; v++) {
            const obj = this._meshes[v].object3D;
            obj.position.z = 0;
            const bucket = this._buckets[v];
            for (let i = 0; i < bucket.length; i++) {
                const p = bucket[i];
                this._position.set(p.x, p.y, this._matrixAnchor - p.z);
                this._quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.rotationY);
                this._scale.setScalar(p.scale);
                this._matrix.compose(this._position, this._quaternion, this._scale);
                obj.setMatrixAt(i, this._matrix);
            }
            obj.count = bucket.length;
            obj.instanceMatrix.needsUpdate = true;
        }
    }

    private _scrollMeshes(): void {
        const z = this._scroll.travelled - this._matrixAnchor;
        for (const mesh of this._meshes) mesh.object3D.position.z = z;
    }

    private _submitShadows(): void {
        if (!this._treeMask) return;
        const maxRoadDistance = cfg.lighting.treeShadows.maxRoadDistance;
        for (let v = 0; v < this._buckets.length; v++) {
            for (const p of this._buckets[v]) {
                if (Math.abs(p.x - roadCenterX(p.z)) > maxRoadDistance) continue;
                this._treeMask.add(this._handles[v], p.x, p.y + cfg.desertProps.sinkDepth, p.z, p.scale);
            }
        }
    }
}
