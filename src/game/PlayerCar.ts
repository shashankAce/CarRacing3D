import * as THREE from 'three';
import { Node, Group3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';
import type { ShadowDecals } from '../world/ShadowDecals';
import type { ProjectedShadows } from '../world/ProjectedShadows';

/**
 * PlayerCar — placeholder box car, its steering, and how it sits on the ground.
 *
 * Forward motion is the world scrolling past (see WorldScroll). The car keeps a
 * rear-pivot lateral position and a steering yaw. Lateral displacement is
 * derived from that same yaw, never from a free sideways velocity.
 *
 * That word is load-bearing, and it's been both ways:
 *
 *  - Storing an absolute x and clamping it to a FIXED ±road.halfWidth was
 *    wrong: on a curving road the asphalt slid sideways out from under a car
 *    that stayed put.
 *  - Storing an offset from the road centre was also wrong, differently: it
 *    made the car track the curve on its own, so the player could take their
 *    hands off through a bend and the curve became decoration.
 *
 * The absolute x is clamped to road edges whose boundary moves with the road.
 * The car never tracks a bend automatically, so holding a curve still requires
 * steering, but there is no independent sideways velocity that can look like a
 * body sliding across the asphalt.
 *
 * It rides `surfaceHeightAt` — the DRIVABLE surface, i.e. the top of the asphalt
 * inside the road corridor and the terrain outside it. Not `heightAt`, which is
 * the terrain mesh: the ribbon is drawn `roadSurface.lift` above the corridor to
 * avoid z-fighting, so resting on the terrain put the car 2cm inside the visible
 * road. Using the drivable surface also means the car already behaves correctly
 * if the design ever does allow leaving the asphalt.
 */
export class PlayerCar {

    private _group: Group3D;
    private _wheels: THREE.Mesh[] = [];
    /** Absolute lateral position of the rear steering pivot, metres. */
    private _x = 0;
    /** Damped steering yaw; negative points right because local forward is -Z. */
    private _yaw = 0;
    /** Damped ride height, pitch and roll — the suspension's state. */
    private _y = 0;
    private _pitch = 0;
    private _roll = 0;
    private _rideEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    private _rideQuaternion = new THREE.Quaternion();
    private _ridePoint = new THREE.Vector3();
    /** True while the car is pinned against a road edge. */
    private _againstEdge = false;

    /** Read by the follow camera. */
    get position(): THREE.Vector3 { return this._group.position; }

    /**
     * True while the car is scraping a road edge. Nothing consumes it yet —
     * it's the hook for Phase 4 to add a scrape sound, a speed penalty, or
     * sparks, whichever the design lands on.
     */
    get isAgainstEdge(): boolean { return this._againstEdge; }

    /** Half-extents used for ground sampling and (Phase 4) collision. */
    /**
     * The car's own decal. Uses the DRIVABLE surface under it rather than the
     * group's y, which carries suspension travel and pitch — a shadow that
     * bobbed with the springs would read as the ground moving.
     */
    /**
     * Silhouette from the body and cabin MERGED, so the shadow has the cabin
     * step in it rather than being one flat box. Built at the same local offsets
     * the visible meshes use, since the silhouette is projected from the same
     * geometry the camera sees.
     */
    registerShadow(decals: ShadowDecals): void {
        const c = cfg.car;
        const body = new THREE.BoxGeometry(c.width, c.height, c.length);
        body.translate(0, c.rideHeight + c.height / 2, 0);
        const cabin = new THREE.BoxGeometry(
            c.width * c.cabinWidthFactor, c.cabinHeight, c.length * c.cabinLengthFactor);
        cabin.translate(0, c.rideHeight + c.height + c.cabinHeight / 2, c.length * 0.1);
        // Two parts, not merged — the baker renders both into one silhouette.
        this._shadowHandle = decals.register([body, cabin]);
    }

    addShadow(decals: ShadowDecals, travelled: number): void {
        // The DRIVABLE surface under the car, not the group's y — that carries
        // suspension travel, and a shadow bobbing with the springs reads as the
        // ground moving rather than the car.
        const position = this._group.object3D.position;
        decals.add(
            this._shadowHandle,
            position.x,
            surfaceHeightAt(position.x, travelled - position.z),
            position.z,
            1,
        );
    }

    private _shadowHandle = -1;
    private _projectedHandle = -1;
    private _materials: THREE.Material[] = [];

    /** Every lit material on the car, so it can RECEIVE other casters' shadows. */
    get receiverMaterials(): THREE.Material[] { return this._materials; }

    /**
     * Registers the car as a projected-shadow caster. Same two parts as the
     * decal path, translated by their real local offsets — the caster origin in
     * the shader is the group's own origin, so the geometry has to be expressed
     * relative to it.
     */
    registerProjected(shadows: ProjectedShadows): void {
        const c = cfg.car;
        const body = new THREE.BoxGeometry(c.width, c.height, c.length);
        body.translate(0, c.rideHeight + c.height / 2, 0);
        const cabin = new THREE.BoxGeometry(
            c.width * c.cabinWidthFactor, c.cabinHeight, c.length * c.cabinLengthFactor);
        cabin.translate(0, c.rideHeight + c.height + c.cabinHeight / 2, c.length * 0.1);
        this._projectedHandle = shadows.register([body, cabin]);
    }

    /** The player's caster handle, so its own material can opt out of it. */
    get projectedHandle(): number { return this._projectedHandle; }

    /**
     * Submits the car for this frame.
     *
     * Unlike the decal path this passes the group's REAL y, suspension travel
     * included. A decal had to ignore it because a quad bobbing on the springs
     * read as the ground moving; a projected shadow lands wherever the light
     * actually puts it, so following the body is the correct answer rather than
     * an artefact. Priority is negative to pin the player a slot.
     */
    addProjected(shadows: ProjectedShadows): void {
        const obj = this._group.object3D;
        shadows.add(
            this._projectedHandle,
            obj.position.x, obj.position.y, obj.position.z,
            obj.rotation.y,
            -1,
        );
    }

    get halfWidth(): number { return cfg.car.width / 2; }
    get halfLength(): number { return cfg.car.length / 2; }

    constructor(scene: Scene) {
        const node = new Node();
        this._group = node.addComponent(Group3D);
        scene.addChild(node);

        const c = cfg.car;
        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: cfg.colors.car.body, roughness: 0.5, metalness: 0.15,
        });
        const cabinMaterial = new THREE.MeshStandardMaterial({
            color: cfg.colors.car.cabin, roughness: 0.35, metalness: 0.2,
        });
        this._materials.push(bodyMaterial, cabinMaterial);
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(c.width, c.height, c.length),
            bodyMaterial,
        );
        body.position.y = c.rideHeight + c.height / 2;

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(c.width * c.cabinWidthFactor, c.cabinHeight, c.length * c.cabinLengthFactor),
            cabinMaterial,
        );
        // Biased toward the rear (+Z) so the silhouette reads as facing -Z.
        cabin.position.set(0, c.rideHeight + c.height + c.cabinHeight / 2, c.length * 0.1);

        body.castShadow = cfg.lighting.shadows.enabled;
        cabin.castShadow = cfg.lighting.shadows.enabled;
        this._group.object3D.add(body, cabin);
        this._buildWheels();
        this.reset();
    }

    /**
     * Four tyres, sharing one geometry and one material.
     *
     * The cylinder's axis is baked onto X at build time (`rotateZ`) rather than
     * by setting `mesh.rotation.z`, so the mesh's own `rotation.x` is free to be
     * the wheel's spin. Rotating the mesh to orient it instead would make the
     * spin axis depend on Euler order, which is a mess to reason about.
     *
     * OPTIMISATION FLAGGED, NOT DONE (deferred by the project owner):
     * from a chase camera the tyres are barely visible — the body occludes most
     * of them and the rear pair almost entirely. So all of this is a candidate
     * for faking or dropping:
     *   - 4 meshes x 12 radial segments each, per vehicle;
     *   - four separate draw calls, since they don't share the body's material;
     *   - a per-frame spin write per wheel.
     * Cheaper options, roughly in order: merge the four tyres into ONE geometry
     * (spin then has to go, or become a scrolling texture); drop the rear pair;
     * or replace all four with a single dark quad under the car. Traffic must
     * NOT copy this pattern as-is — a dozen vehicles would be ~72 draw calls.
     */
    private _buildWheels(): void {
        const c = cfg.car, w = c.wheel;
        const geometry = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 12);
        geometry.rotateZ(Math.PI / 2);
        const material = new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.85 });
        this._materials.push(material);

        const x = c.width / 2 - w.width * (0.5 - w.outboard);
        const z = this.halfLength * w.axleOffset;
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const wheel = new THREE.Mesh(geometry, material);
                // Wheels deliberately don't cast — they're inside the body's own
                // shadow from any sun angle that isn't near-horizontal, so it's
                // four more casters for nothing.
                wheel.castShadow = false;
                // Axle at exactly `radius` puts the tread on the ground plane,
                // which is the plane the group's origin sits on.
                wheel.position.set(sx * x, w.radius, sz * z);
                this._group.object3D.add(wheel);
                this._wheels.push(wheel);
            }
        }
    }

    /** Drivable height beneath a yawed point on the car's local ground plane. */
    private _heightAtLocal(
        localX: number,
        localZ: number,
        centreX: number,
        centreWorldZ: number,
    ): number {
        const sin = Math.sin(this._yaw);
        const cos = Math.cos(this._yaw);
        const x = centreX + localX * cos + localZ * sin;
        // Render Z is mirrored relative to absolute world Z.
        const z = centreWorldZ + localX * sin - localZ * cos;
        return surfaceHeightAt(x, z);
    }

    /** Lowest origin height that keeps the yawed, tilted footprint above ground. */
    private _requiredHeight(
        centreX: number,
        centreWorldZ: number,
        pitch: number,
        roll: number,
    ): number {
        this._rideEuler.set(pitch, this._yaw, roll, 'YXZ');
        this._rideQuaternion.setFromEuler(this._rideEuler);

        const hw = this.halfWidth;
        const hl = this.halfLength;
        let required = -Infinity;
        // Corners, axle centres and chassis centre handle slopes, dips and crests
        // without allocating contact objects during the frame.
        for (let xi = -1; xi <= 1; xi++) {
            for (let zi = -1; zi <= 1; zi++) {
                const localX = xi * hw;
                const localZ = zi * hl;
                this._ridePoint.set(localX, 0, localZ).applyQuaternion(this._rideQuaternion);
                const need = this._heightAtLocal(localX, localZ, centreX, centreWorldZ)
                    - this._ridePoint.y;
                if (need > required) required = need;
            }
        }
        return required;
    }

    /**
     * @param axis    -1 … +1 from InputController.
     * @param worldZ  The car's absolute world Z — i.e. `scroll.travelled`, since
     *                the car always renders at z ≈ 0.
     * @param speed   Forward road speed, m/s — drives the yaw path and wheels.
     */
    update(dt: number, axis: number, worldZ: number, speed: number): void {
        const steering = cfg.car.steering;

        // Input controls the visible rear-pivot rotation directly. It keeps the
        // full configured range at every speed, so changing speed cannot make
        // the body unexpectedly straighten while the player holds steering.
        const targetYaw = -axis * steering.maxYawAngle;
        const steerK = 1 - Math.exp(-steering.response * dt);
        this._yaw += (targetYaw - this._yaw) * steerK;

        // Clamp to the asphalt. The limits are computed from the road centre at
        // the car's own z, so they TRACK the curve — but the car's position
        // doesn't, which is what forces the player to steer.
        // The movement path uses the exact input-driven yaw, keeping the body
        // direction and travel direction aligned without sideways slip.
        this._x -= Math.tan(this._yaw) * speed * dt;
        const centreX = roadCenterX(worldZ);
        const limit = cfg.road.halfWidth - this.halfWidth;
        const minX = centreX - limit, maxX = centreX + limit;
        if (this._x < minX) { this._x = minX; this._againstEdge = true; }
        else if (this._x > maxX) { this._x = maxX; this._againstEdge = true; }
        else this._againstEdge = false;

        const pivotZ = this.halfLength * steering.yawPivotFactor;
        const bodyX = this._x - Math.sin(this._yaw) * pivotZ;
        const bodyRenderZ = pivotZ * (1 - Math.cos(this._yaw));
        const bodyWorldZ = worldZ - bodyRenderZ;

        // Derive the supporting road plane from the four actual tyre contact
        // locations after yaw. Axis-aligned samples were the reason the body
        // stopped matching the road whenever it was turned on a slope.
        const wheel = cfg.car.wheel;
        const wheelX = cfg.car.width / 2 - wheel.width * (0.5 - wheel.outboard);
        const axleZ = this.halfLength * wheel.axleOffset;
        const frontLeft = this._heightAtLocal(-wheelX, -axleZ, bodyX, bodyWorldZ);
        const frontRight = this._heightAtLocal(wheelX, -axleZ, bodyX, bodyWorldZ);
        const rearLeft = this._heightAtLocal(-wheelX, axleZ, bodyX, bodyWorldZ);
        const rearRight = this._heightAtLocal(wheelX, axleZ, bodyX, bodyWorldZ);
        const front = (frontLeft + frontRight) * 0.5;
        const rear = (rearLeft + rearRight) * 0.5;
        const left = (frontLeft + rearLeft) * 0.5;
        const right = (frontRight + rearRight) * 0.5;

        // Rotating about +X tilts the forward axis (-Z) up, so a front higher
        // than the rear is positive pitch. Negative +Z rotation raises the left
        // tyre, so left-high ground produces negative roll.
        const targetPitch = Math.atan2(front - rear, axleZ * 2);
        const targetRoll = Math.atan2(right - left, wheelX * 2);

        const suspension = cfg.car.suspension;
        const tiltK = 1 - Math.exp(-suspension.tiltResponse * dt);
        this._pitch += (targetPitch - this._pitch) * tiltK;
        this._roll += (targetRoll - this._roll) * tiltK;

        const floor = this._requiredHeight(bodyX, bodyWorldZ, this._pitch, this._roll);
        const heightK = 1 - Math.exp(-suspension.heightResponse * dt);
        this._y += (floor - this._y) * heightK;

        // Clamp both sides of the damped travel. Rising ground cannot penetrate
        // the car, and falling ground cannot open the large gap that read as
        // floating on descents.
        if (this._y < floor) this._y = floor;
        const ceiling = floor + suspension.maxGroundGap;
        if (this._y > ceiling) this._y = ceiling;

        const obj = this._group.object3D;
        // Roll stacks on the ground tilt. Yaw follows steering input directly;
        // roll grows with both steering amount and speed.
        const turnT = steering.maxYawAngle === 0 ? 0 : -this._yaw / steering.maxYawAngle;
        const speedFactor = THREE.MathUtils.clamp(speed / cfg.speed.max, 0, 1);

        // THREE rotates an object about its centre. Translate that centre along
        // the arc around a fixed rear pivot so the rear stays planted and the
        // nose visibly sweeps into the turn instead of merely spinning in place.
        obj.position.set(
            bodyX,
            this._y,
            bodyRenderZ,
        );
        // YXZ keeps pitch and ground roll local to the yawed chassis.
        obj.rotation.set(
            this._pitch,
            this._yaw,
            this._roll + turnT * steering.maxRollAngle * speedFactor,
            'YXZ',
        );

        // Roll the tyres. A wheel carrying the car forward (-Z) has its top
        // moving -Z too, which is a NEGATIVE rotation about +X.
        const spin = (speed / cfg.car.wheel.radius) * dt;
        for (const wheel of this._wheels) wheel.rotation.x -= spin;
    }

    reset(): void {
        this._x = roadCenterX(0);
        this._yaw = 0;
        this._pitch = 0;
        this._roll = 0;
        this._y = this._requiredHeight(this._x, 0, 0, 0);
        this._againstEdge = false;
        this._group.object3D.position.set(this._x, this._y, 0);
        this._group.object3D.rotation.set(0, 0, 0, 'YXZ');
        for (const wheel of this._wheels) wheel.rotation.x = 0;
    }
}
