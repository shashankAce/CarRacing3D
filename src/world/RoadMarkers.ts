import * as THREE from 'three';
import { Node, InstancedMesh3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadLevelAt, roadHeadingAt, roadPitchAt } from './roadPath';
import { heightAt } from '../procedural/heightField';
import type { WorldScroll } from './WorldScroll';

/**
 * RoadMarkers — the scrolling centre-line dashes and roadside posts.
 *
 * On the flat placeholder world these are the only thing conveying motion, and
 * they're deliberately built the way the Phase 6 scatter fields will be: one
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
    // Scratch objects, reused for every instance every frame — this runs
    // `dash.count + post.count * 2` times per frame and must not allocate.
    private _matrix = new THREE.Matrix4();
    private _position = new THREE.Vector3();
    private _euler = new THREE.Euler();
    private _quaternion = new THREE.Quaternion();
    private _scale = new THREE.Vector3(1, 1, 1);

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
        // Posts deliberately do NOT cast. "One instanced draw, so nearly free"
        // was wrong: it's 64 more boxes rasterised into the shadow map every
        // frame, and their shadows are thin slivers on the verge that nobody
        // looks at. The dashes lie flat on the asphalt and would only ever
        // shadow themselves.

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

    /**
     * Call once per frame, after GameState has advanced the scroll.
     *
     * Both sets follow `roadCenterX(worldZ)` rather than assuming x=0, so they
     * track a curving road.
     *
     * The dashes additionally take the road's heading and grade, because a dash
     * is 3m long: position alone leaves an axis-aligned box cutting across a
     * bend and burying its ends on a slope. The posts need neither — they're
     * ~0.18m square, so rotation is invisible on them, and a real roadside post
     * stands vertical regardless of the ground. They do sample the height field
     * for their base, since they stand on the shoulder rather than on the flat
     * road corridor.
     */
    update(): void {
        const ahead = cfg.markers.aheadFraction;
        const travelled = this._scroll.travelled;

        const d = cfg.markers.dash;
        const dashLift = cfg.roadSurface.lift + 0.01;
        for (let i = 0; i < d.count; i++) {
            const z = this._scroll.repeatingZ(i, d.spacing, d.count, ahead);
            const worldZ = travelled - z;
            this._position.set(roadCenterX(worldZ), roadLevelAt(worldZ) + dashLift, z);
            this._euler.set(roadPitchAt(worldZ, d.length), roadHeadingAt(worldZ), 0);
            this._quaternion.setFromEuler(this._euler);
            this._matrix.compose(this._position, this._quaternion, this._scale);
            this._dashes.object3D.setMatrixAt(i, this._matrix);
        }
        this._dashes.object3D.instanceMatrix.needsUpdate = true;

        const p = cfg.markers.post;
        const offset = cfg.road.halfWidth + p.offset;
        for (let i = 0; i < p.count; i++) {
            const z = this._scroll.repeatingZ(i, p.spacing, p.count, ahead);
            const worldZ = travelled - z;
            const centre = roadCenterX(worldZ);
            for (let side = 0; side < 2; side++) {
                const x = centre + (side === 0 ? -offset : offset);
                const base = heightAt(x, worldZ);
                this._matrix.makeTranslation(x, base + p.height / 2, z);
                this._posts.object3D.setMatrixAt(i * 2 + side, this._matrix);
            }
        }
        this._posts.object3D.instanceMatrix.needsUpdate = true;
    }
}
