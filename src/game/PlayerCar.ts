import * as THREE from 'three';
import { Node, Scene } from 'noonengine';
import { Group3D } from 'noonengine/3d';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX } from '../world/roadPath';
import { VehicleGrounding, fallbackTyreContacts } from './VehicleGrounding';
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
    /** Tyre-supported chassis height, pitch and roll. */
    private _y = 0;
    private _pitch = 0;
    private _roll = 0;
    private _grounding = new VehicleGrounding();
    private _tyreContacts = fallbackTyreContacts(this._width, this._length);
    /** True while the car is pinned against a road edge. */
    private _againstEdge = false;

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
            obj.quaternion,
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
        this._tyreContacts = visual.tyreContacts.length >= 3
            ? visual.tyreContacts : fallbackTyreContacts(this._width, this._length);
        this._materials = visual.materials;
        this._shadowGeometries = visual.shadowGeometries;
        this._spinWheels = visual.spinWheels;
        this._group.object3D.add(this._visual);
        this.reset();
    }

    /** Switches the already-registered shadow slot to the selected FBX mesh. */
    refreshProjectedGeometry(shadows: ProjectedShadows): void {
        if (this._shadowGeometries.length > 0) {
            shadows.setCasterGeometry(this._projectedHandle, this._shadowGeometries);
        }
    }

    /**
     * @param axis    -1 … +1 from InputController.
     * @param worldZ  The car's absolute world Z — i.e. `scroll.travelled`, since
     *                the car always renders at z ≈ 0.
     * @param speed   Forward road speed, m/s — drives the yaw path and wheels.
     * @param speedT  Selected vehicle's normalized speed, retained for callers.
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

        this._grounding.solve(this._tyreContacts, bodyX, bodyWorldZ, this._yaw);
        this._pitch = this._grounding.pitch;
        this._roll = this._grounding.roll;
        this._y = this._grounding.height;

        const obj = this._group.object3D;
        // THREE rotates an object about its centre. Translate that centre along
        // the arc around a fixed rear pivot so the rear stays planted and the
        // nose visibly sweeps into the turn instead of merely spinning in place.
        obj.position.set(
            bodyX,
            this._y,
            bodyRenderZ,
        );
        // YXZ keeps pitch and ground roll local to the yawed chassis. Extra
        // steering bank would rotate the rigid tyre assembly off this plane.
        obj.rotation.set(
            this._pitch,
            this._yaw,
            this._roll,
            'YXZ',
        );
        this._spinWheels(worldZ);

    }

    reset(): void {
        this._x = roadCenterX(0);
        this._yaw = 0;
        this._grounding.solve(this._tyreContacts, this._x, 0, 0);
        this._pitch = this._grounding.pitch;
        this._roll = this._grounding.roll;
        this._y = this._grounding.height;
        this._againstEdge = false;
        this._group.object3D.position.set(this._x, this._y, 0);
        this._group.object3D.rotation.set(this._pitch, 0, this._roll, 'YXZ');
    }
}
