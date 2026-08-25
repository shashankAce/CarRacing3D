import * as THREE from 'three';
import { Node, Group3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/**
 * PlayerCar — placeholder box car, its lateral steering, and its cosmetic tilt.
 *
 * The car only ever moves on X: forward motion is the world scrolling past it
 * (see WorldScroll). Lateral velocity is damped toward the input rather than
 * set from it, so the car carries weight and a tap doesn't teleport it.
 *
 * It's a `Group3D` holding plain meshes rather than a Node tree, because 3D
 * wrappers do NOT follow the Node hierarchy — see ARCHITECTURE.md §3 item 6.
 * That also makes the later FBX swap "empty the group, add the loaded scene".
 */
export class PlayerCar {

    private _group: Group3D;
    /** Lateral velocity, m/s. */
    private _vx = 0;

    /** Read by the follow camera. */
    get position(): THREE.Vector3 { return this._group.position; }
    get lateralSpeedT(): number { return this._vx / cfg.steering.maxLateralSpeed; }

    /** Half-extents used for the lateral clamp and (Phase 4) collision. */
    get halfWidth(): number { return cfg.car.width / 2; }
    get halfLength(): number { return cfg.car.length / 2; }

    constructor(scene: Scene) {
        const node = new Node();
        this._group = node.addComponent(Group3D);
        scene.addChild(node);

        const c = cfg.car;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(c.width, c.height, c.length),
            new THREE.MeshStandardMaterial({ color: cfg.colors.car.body, roughness: 0.5, metalness: 0.15 }),
        );
        body.position.y = c.height / 2;

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(c.width * c.cabinWidthFactor, c.cabinHeight, c.length * c.cabinLengthFactor),
            new THREE.MeshStandardMaterial({ color: cfg.colors.car.cabin, roughness: 0.35, metalness: 0.2 }),
        );
        // Biased toward the rear (+Z) so the silhouette reads as facing -Z.
        cabin.position.set(0, c.height + c.cabinHeight / 2, c.length * 0.1);

        this._group.object3D.add(body, cabin);
        this._group.position.set(0, 0, 0);
    }

    /** @param axis -1 … +1 from InputController. */
    update(dt: number, axis: number): void {
        const s = cfg.steering;

        // Exponential damping toward the target velocity — frame-rate
        // independent, unlike a fixed per-frame lerp factor.
        const targetVx = axis * s.maxLateralSpeed;
        this._vx += (targetVx - this._vx) * (1 - Math.exp(-s.response * dt));

        const obj = this._group.object3D;
        const limit = cfg.road.halfWidth - this.halfWidth;
        let x = obj.position.x + this._vx * dt;
        if (x < -limit) { x = -limit; this._vx = 0; }
        else if (x > limit) { x = limit; this._vx = 0; }
        obj.position.x = x;

        // Cosmetic only. Rotating about +Y turns the nose (-Z) toward -X, so a
        // rightward drift needs a negative yaw; rotating about +Z tilts the
        // roof toward -X, which is the "lean into it" direction going right.
        const t = this.lateralSpeedT;
        obj.rotation.y = -t * cfg.steering.yawFactor;
        obj.rotation.z = t * cfg.steering.rollFactor;
    }

    reset(): void {
        this._vx = 0;
        this._group.object3D.position.x = 0;
        this._group.object3D.rotation.set(0, 0, 0);
    }
}
