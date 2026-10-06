import * as THREE from 'three';
import { Node, Scene } from 'noonengine';
import { Group3D } from 'noonengine/3d';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';
import type { ProjectedShadows } from '../world/ProjectedShadows';
import type { VehicleVisual } from '../assets/VehicleModels';

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
    private _visual: THREE.Object3D | null = null;
    private _shadowGeometries: THREE.BufferGeometry[] = [];
    private _spinWheels: (distance: number) => void = () => {};
    private _width = cfg.vehicles.models.find((model) => model.id === cfg.vehicles.playerDefault)?.width ?? cfg.car.width;
    private _height = cfg.vehicles.models.find((model) => model.id === cfg.vehicles.playerDefault)?.height ?? cfg.car.height;
    private _length = cfg.vehicles.models.find((model) => model.id === cfg.vehicles.playerDefault)?.length ?? cfg.car.length;
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
    /** Rendered tyre contact points (x/z) of the current visual; empty = placeholder. */
    private _wheelContacts: { x: number; z: number }[] = [];
    /** Height of the rendered tyre bottoms above the origin plane; 0 for the placeholder. */
    private _wheelBottomOffset = 0;

    /**
     * Per-frame ride telemetry for `RideDebugDraw` — the suspension's targets
     * and actuals, the floor it solved for, and the four surface heights it
     * sampled. Written in `update`/`reset`, read by the overlay; one object,
     * never reallocated.
     */
    readonly rideDebug = {
        yaw: 0,
        pitch: 0,
        pitchTarget: 0,
        roll: 0,
        rollTarget: 0,
        y: 0,
        floor: 0,
        worldZ: 0,
        /** Sample footprint the targets were derived from, metres. */
        wheelX: 0,
        axleZ: 0,
        frontLeft: 0,
        frontRight: 0,
        rearLeft: 0,
        rearRight: 0,
        front: 0,
        rear: 0,
        left: 0,
        right: 0,
    };

    /** Read by the follow camera. */
    get position(): THREE.Vector3 { return this._group.position; }
    /** Current body yaw, used to enclose the rotated visual in its collision box. */
    get rotationY(): number { return this._group.object3D.rotation.y; }
    /** Configured visual height above the ground-pivot origin. */
    get visualHeight(): number { return this._height; }

    /**
     * True while the car is scraping a road edge. Nothing consumes it yet —
     * it's the hook for Phase 4 to add a scrape sound, a speed penalty, or
     * sparks, whichever the design lands on.
     */
    get isAgainstEdge(): boolean { return this._againstEdge; }

    /** The group's live orientation — the ride debug overlay draws the body axes from it. */
    get bodyQuaternion(): THREE.Quaternion { return this._group.object3D.quaternion; }

    /** Ground-plane tyre contacts of the set visual; empty while the placeholder is up. */
    get wheelContacts(): { x: number; z: number }[] { return this._wheelContacts; }

    /** Rendered tyre bottoms above the origin plane, metres — a baked-in float. */
    get wheelBottomOffset(): number { return this._wheelBottomOffset; }

    /**
     * Writes [FL, FR, RL, RR] ground-plane tyre contacts into `out` — the FBX
     * positions when a visual is set (where the rendered wheel actually
     * touches), else the sampled footprint. Front is −Z (the game's forward).
     * Shared by the ride overlay and the ride telemetry so the two can never
     * disagree about which point they measured.
     */
    writeTyreLocals(out: number[][]): void {
        const wheelX = this.halfWidth * 0.84;
        const axleZ = this.halfLength * cfg.car.wheel.axleOffset;
        out[0] = [-wheelX, -axleZ];
        out[1] = [wheelX, -axleZ];
        out[2] = [-wheelX, axleZ];
        out[3] = [wheelX, axleZ];
        for (const p of this._wheelContacts) {
            out[(p.z < 0 ? 0 : 2) + (p.x < 0 ? 0 : 1)] = [p.x, p.z];
        }
    }

    /** Half-extents used for ground sampling and (Phase 4) collision. */
    private _projectedHandle = -1;
    private _materials: THREE.Material[] = [];

    /** Every lit material on the car, so it can RECEIVE other casters' shadows. */
    get receiverMaterials(): THREE.Material[] { return this._materials; }

    /**
     * Registers the car as a projected-shadow caster: body and cabin,
     * translated by their real local offsets — the caster origin in the
     * shader is the group's own origin, so the geometry has to be expressed
     * relative to it.
     */
    registerProjected(shadows: ProjectedShadows): void {
        const c = cfg.car;
        const body = new THREE.BoxGeometry(this._width, this._height, this._length);
        body.translate(0, this._height / 2, 0);
        const cabin = new THREE.BoxGeometry(
            this._width * c.cabinWidthFactor, c.cabinHeight, this._length * c.cabinLengthFactor);
        cabin.translate(0, this._height + c.cabinHeight / 2, this._length * 0.1);
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

    get halfWidth(): number { return this._width / 2; }
    get halfLength(): number { return this._length / 2; }

    constructor(scene: Scene) {
        const node = new Node();
        this._group = node.addComponent(Group3D);
        scene.addChild(node);

        this.reset();
    }

    /** Replaces the invisible startup placeholder with the selected FBX clone. */
    setVisual(visual: VehicleVisual): void {
        if (this._visual) this._group.object3D.remove(this._visual);
        this._visual = visual.root;
        // Collision follows the actual post-scale asset bounds. Keeping these
        // values separate in config allowed a visual scale edit to silently
        // leave a smaller collider behind.
        this._width = visual.dimensions.width;
        this._height = visual.dimensions.height;
        this._length = visual.dimensions.length;
        this._materials = visual.materials;
        this._shadowGeometries = visual.shadowGeometries;
        this._spinWheels = visual.spinWheels;
        this._wheelContacts = visual.wheelContacts;
        this._wheelBottomOffset = visual.wheelBottomOffset;
        this._group.object3D.add(this._visual);
        this.reset();
    }

    /** Switches the already-registered shadow slot to the selected FBX mesh. */
    refreshProjectedGeometry(shadows: ProjectedShadows): void {
        if (this._shadowGeometries.length > 0) {
            shadows.setCasterGeometry(this._projectedHandle, this._shadowGeometries);
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
     * @param speedT  Selected vehicle's normalized speed, from 0 to 1.
     */
    update(dt: number, axis: number, worldZ: number, speed: number, speedT: number): void {
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
        const wheelX = this.halfWidth * 0.84;
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

        // Ride telemetry for the debug overlay — every value already in hand.
        const tel = this.rideDebug;
        tel.yaw = this._yaw;
        tel.pitch = this._pitch; tel.pitchTarget = targetPitch;
        tel.roll = this._roll; tel.rollTarget = targetRoll;
        tel.y = this._y; tel.floor = floor;
        tel.worldZ = worldZ;
        tel.wheelX = wheelX; tel.axleZ = axleZ;
        tel.frontLeft = frontLeft; tel.frontRight = frontRight;
        tel.rearLeft = rearLeft; tel.rearRight = rearRight;
        tel.front = front; tel.rear = rear; tel.left = left; tel.right = right;

        const obj = this._group.object3D;
        // Roll stacks on the ground tilt. Yaw follows steering input directly;
        // roll grows with both steering amount and speed.
        const turnT = steering.maxYawAngle === 0 ? 0 : -this._yaw / steering.maxYawAngle;
        const speedFactor = THREE.MathUtils.clamp(speedT, 0, 1);

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
        this._spinWheels(worldZ);

    }

    reset(): void {
        this._x = roadCenterX(0);
        this._yaw = 0;

        // Sample the road FIRST and seed the attitude from it. Pitching from 0
        // on the road's initial ~5° grade made every run open with the body
        // bridging flat over rising asphalt: ride telemetry measured 21cm of
        // float and 3.4° of pitch error on the first frame, settling only after
        // ~0.3s — the biggest single "car is flying" event of a run.
        const wheelX = this.halfWidth * 0.84;
        const axleZ = this.halfLength * cfg.car.wheel.axleOffset;
        const frontLeft = this._heightAtLocal(-wheelX, -axleZ, this._x, 0);
        const frontRight = this._heightAtLocal(wheelX, -axleZ, this._x, 0);
        const rearLeft = this._heightAtLocal(-wheelX, axleZ, this._x, 0);
        const rearRight = this._heightAtLocal(wheelX, axleZ, this._x, 0);
        const front = (frontLeft + frontRight) * 0.5;
        const rear = (rearLeft + rearRight) * 0.5;
        const left = (frontLeft + rearLeft) * 0.5;
        const right = (frontRight + rearRight) * 0.5;
        this._pitch = Math.atan2(front - rear, axleZ * 2);
        this._roll = Math.atan2(right - left, wheelX * 2);

        const floor = this._requiredHeight(this._x, 0, this._pitch, this._roll);
        this._y = floor;
        this._againstEdge = false;
        this._group.object3D.position.set(this._x, this._y, 0);
        // Seeded attitude too — a frame rendered between reset and the first
        // update must not show the car flat while its y was solved tilted.
        this._group.object3D.rotation.set(this._pitch, 0, this._roll, 'YXZ');

        const tel = this.rideDebug;
        tel.yaw = 0;
        tel.pitch = this._pitch; tel.pitchTarget = this._pitch;
        tel.roll = this._roll; tel.rollTarget = this._roll;
        tel.y = this._y; tel.floor = floor;
        tel.worldZ = 0;
        tel.wheelX = wheelX; tel.axleZ = axleZ;
        tel.frontLeft = frontLeft; tel.frontRight = frontRight;
        tel.rearLeft = rearLeft; tel.rearRight = rearRight;
        tel.front = front; tel.rear = rear; tel.left = left; tel.right = right;
    }
}
