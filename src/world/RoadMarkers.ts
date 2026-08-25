import * as THREE from 'three';
import { Node, InstancedMesh3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { WorldScroll } from './WorldScroll';

/**
 * RoadMarkers — the scrolling centre-line dashes and roadside posts.
 *
 * On the flat placeholder world these are the only thing conveying motion, and
 * they're deliberately built the way the Phase 4 scatter fields will be: one
 * InstancedMesh per prop type, matrices rewritten each frame.
 *
 * Two engine rules are load-bearing here (ARCHITECTURE.md §3, items 4 and 5):
 *  - `count` is allocated ONCE. Assigning the wrapper's `count` later rebuilds
 *    the whole InstancedMesh and discards every matrix.
 *  - `frustumCulled = false`, because the instances sit far from the
 *    geometry's local origin and the default bounding sphere doesn't cover
 *    them — they'd get silently culled.
 */
export class RoadMarkers {

    private _dashes: InstancedMesh3D;
    private _posts: InstancedMesh3D;
    private _scroll: WorldScroll;
    private _matrix = new THREE.Matrix4();

    constructor(scene: Scene, scroll: WorldScroll) {
        this._scroll = scroll;

        const d = cfg.markers.dash;
        this._dashes = this._makeSet(
            scene,
            new THREE.BoxGeometry(d.width, 0.02, d.length),
            cfg.colors.roadLine,
            d.count,
        );

        const p = cfg.markers.post;
        // Posts come in pairs, one per side of the road.
        this._posts = this._makeSet(
            scene,
            new THREE.BoxGeometry(p.width, p.height, p.width),
            p.color,
            p.count * 2,
        );

        this.update();
    }

    private _makeSet(scene: Scene, geometry: THREE.BufferGeometry, color: number, count: number): InstancedMesh3D {
        const node = new Node();
        const mesh = node.addComponent(InstancedMesh3D);
        mesh.geometry = geometry;
        mesh.material = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
        mesh.count = count;
        scene.addChild(node);
        mesh.object3D.frustumCulled = false;
        return mesh;
    }

    /** Call once per frame, after GameState has advanced the scroll. */
    update(): void {
        const ahead = cfg.markers.aheadFraction;

        const d = cfg.markers.dash;
        for (let i = 0; i < d.count; i++) {
            const z = this._scroll.repeatingZ(i, d.spacing, d.count, ahead);
            this._matrix.makeTranslation(0, 0.03, z);
            this._dashes.object3D.setMatrixAt(i, this._matrix);
        }
        this._dashes.object3D.instanceMatrix.needsUpdate = true;

        const p = cfg.markers.post;
        const postX = cfg.road.halfWidth + p.offset;
        for (let i = 0; i < p.count; i++) {
            const z = this._scroll.repeatingZ(i, p.spacing, p.count, ahead);
            for (let side = 0; side < 2; side++) {
                this._matrix.makeTranslation(side === 0 ? -postX : postX, p.height / 2, z);
                this._posts.object3D.setMatrixAt(i * 2 + side, this._matrix);
            }
        }
        this._posts.object3D.instanceMatrix.needsUpdate = true;
    }
}
