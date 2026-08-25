import * as THREE from 'three';
import { Node, Camera3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { PlayerCar } from './PlayerCar';

/**
 * FollowCamera — TPP chase camera, exponentially damped.
 *
 * Damping uses `1 - exp(-rate * dt)` rather than a fixed lerp factor. A plain
 * `lerp(a, b, 0.1)` per frame is frame-rate dependent: it would feel different
 * on a 120Hz phone than in a 60Hz dev browser, which is exactly the kind of
 * bug that only shows up on someone else's device. See ARCHITECTURE.md §5.6.
 *
 * The lag is the point — the camera trailing the car's lateral movement is
 * most of what makes steering feel like it has weight.
 */
export class FollowCamera {

    private _camera: Camera3D;
    private _lookAt = new THREE.Vector3();
    private _desired = new THREE.Vector3();

    constructor(scene: Scene) {
        const node = new Node();
        this._camera = node.addComponent(Camera3D);
        this._camera.fov = cfg.camera.fov;
        this._camera.near = cfg.camera.near;
        this._camera.far = cfg.camera.far;
        // addChild before any transform — onEnable() is what creates the
        // THREE camera (ARCHITECTURE.md §3 item 3).
        scene.addChild(node);
    }

    /** @param speedT 0…1 from GameState — widens FOV and eases back as speed rises. */
    update(dt: number, car: PlayerCar, speedT: number): void {
        const c = cfg.camera;
        const distance = c.distance + speedT * c.distanceSpeedGain;

        this._desired.set(car.position.x, car.position.y + c.height, car.position.z + distance);

        const k = 1 - Math.exp(-c.followRate * dt);
        const pos = this._camera.position;
        pos.lerp(this._desired, k);

        // The look-at target sits directly ahead of the CAMERA, not of the car.
        // Aiming at the car's x would yaw the camera every time the car moved
        // sideways — the world would appear to swing rather than slide. Using
        // the camera's own x keeps the view axis permanently parallel to -Z, so
        // steering reads as pure lateral translation.
        this._lookAt.set(pos.x, car.position.y + c.lookHeight, pos.z - c.lookAhead);
        this._camera.lookAt(this._lookAt.x, this._lookAt.y, this._lookAt.z);

        // A slightly wider FOV at speed stretches the periphery and reads as
        // acceleration. Guarded because the setter rebuilds the projection
        // matrix on every assignment.
        const fov = c.fov + speedT * c.fovSpeedGain;
        if (Math.abs(this._camera.fov - fov) > 0.05) this._camera.fov = fov;
    }

    /** Jump straight to the rest pose, with no easing — for scene start and restart. */
    snapTo(car: PlayerCar): void {
        const c = cfg.camera;
        const pos = this._camera.position;
        pos.set(car.position.x, car.position.y + c.height, car.position.z + c.distance);
        this._camera.fov = c.fov;
        this._camera.lookAt(pos.x, car.position.y + c.lookHeight, pos.z - c.lookAhead);
    }
}
