import * as THREE from 'three';
import { Node, Group3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadHeadingAt } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';
import type { ShadowDecals } from '../world/ShadowDecals';
import type { ProjectedShadows } from '../world/ProjectedShadows';

/**
 * PlayerCar — placeholder box car, its steering, and how it sits on the ground.
 *
 * Forward motion is the world scrolling past (see WorldScroll), so the car's own
 * driving state is its absolute lateral position and heading. A bicycle model
 * turns forward speed through the steered front axle into both lateral and
 * forward displacement. The world still scrolls, but only by the forward part
 * of that displacement; the heading limit guarantees that part never reverses.
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
    private _frontWheels: Array<{ mesh: THREE.Mesh; side: number }> = [];
    /** Absolute lateral world position, metres. */
    private _x = 0;
    /** Chassis yaw. Negative yaw points right because local forward is -Z. */
    private _heading = 0;
    /** Signed centre-wheel steering angle. Positive input means right. */
    private _steerAngle = 0;
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
    /** Read by collision code; uses the same yaw as the visible chassis. */
    get heading(): number { return this._heading; }

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
        decals.add(
            this._shadowHandle,
            this._x,
            surfaceHeightAt(this._x, travelled),
            0,
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
                // Steering is applied about local Y before spin about the axle.
                wheel.rotation.order = 'YXZ';
                // Axle at exactly `radius` puts the tread on the ground plane,
                // which is the plane the group's origin sits on.
                wheel.position.set(sx * x, w.radius, sz * z);
                this._group.object3D.add(wheel);
                this._wheels.push(wheel);
                // Local -Z is the front axle.
                if (sz < 0) this._frontWheels.push({ mesh: wheel, side: sx });
            }
        }
    }

    /**
     * Drivable height beneath a point on the car's local ground plane. Sampling
     * through the current heading is essential: once a car yaws, its front and
     * rear tyres no longer sit at the same X as its centre.
     */
    private _heightAtLocal(localX: number, localZ: number, worldZ: number): number {
        const sin = Math.sin(this._heading);
        const cos = Math.cos(this._heading);
        const x = this._x + localX * cos + localZ * sin;
        // Render Z is mirrored relative to absolute world Z.
        const z = worldZ + localX * sin - localZ * cos;
        return surfaceHeightAt(x, z);
    }

    /** Lowest origin height that keeps the yawed, tilted footprint above ground. */
    private _requiredHeight(worldZ: number): number {
        this._rideEuler.set(this._pitch, this._heading, this._roll, 'YXZ');
        this._rideQuaternion.setFromEuler(this._rideEuler);

        const hw = this.halfWidth;
        const hl = this.halfLength;
        let required = -Infinity;
        // Corners, axle centres and chassis centre catch slopes, crests and dips
        // without allocating contact-point objects every frame.
        for (let xi = -1; xi <= 1; xi++) {
            for (let zi = -1; zi <= 1; zi++) {
                const localX = xi * hw;
                const localZ = zi * hl;
                this._ridePoint.set(localX, 0, localZ).applyQuaternion(this._rideQuaternion);
                const need = this._heightAtLocal(localX, localZ, worldZ) - this._ridePoint.y;
                if (need > required) required = need;
            }
        }
        return required;
    }

    /** Applies Ackermann steering: the tyre on the inside turns more sharply. */
    private _updateFrontWheelAngles(): void {
        const angle = this._steerAngle;
        if (Math.abs(angle) < Number.EPSILON) {
            for (const front of this._frontWheels) front.mesh.rotation.y = 0;
            return;
        }

        const wheelbase = cfg.car.length * cfg.car.wheel.axleOffset;
        const track = Math.abs(this._frontWheels[1].mesh.position.x
            - this._frontWheels[0].mesh.position.x);
        const sign = Math.sign(angle);
        const radius = wheelbase / Math.tan(Math.abs(angle));
        const inner = Math.atan2(wheelbase, Math.max(Number.EPSILON, radius - track / 2));
        const outer = Math.atan2(wheelbase, radius + track / 2);

        for (const front of this._frontWheels) {
            const tyreAngle = sign * (front.side === sign ? inner : outer);
            // Positive gameplay steering is right, which is negative THREE yaw.
            front.mesh.rotation.y = -tyreAngle;
        }
    }

    /**
     * @param axis    -1 … +1 from InputController.
     * @param worldZ  Absolute world Z at the start of the frame.
     * @param speed   Speed along the car's own forward axis, m/s.
     * @returns Forward-only world-Z distance for WorldScroll to advance.
     */
    update(dt: number, axis: number, worldZ: number, speed: number): number {
        const steering = cfg.car.steering;

        // The input turns the front axle, not the whole car. Exponential
        // response makes keys and digital touch buttons usable while remaining
        // frame-rate independent.
        const targetSteer = axis * steering.maxWheelAngle;
        const steerK = 1 - Math.exp(-steering.response * dt);
        this._steerAngle += (targetSteer - this._steerAngle) * steerK;

        const wheelbase = cfg.car.length * cfg.car.wheel.axleOffset;
        const oldHeading = this._heading;
        const yawDelta = speed / wheelbase * Math.tan(this._steerAngle) * dt;
        // Enforce the no-reverse invariant even if a tune accidentally puts the
        // configured threshold beyond 90 degrees.
        const headingLimit = Math.min(Math.abs(steering.maxHeadingAngle), Math.PI / 2);
        this._heading = THREE.MathUtils.clamp(
            oldHeading - yawDelta,
            -headingLimit,
            headingLimit,
        );

        // Midpoint integration keeps a turn symmetrical within the frame. The
        // configured heading threshold is below 90 degrees, so cos() is always
        // positive and WorldScroll can never move backward.
        const midHeading = (oldHeading + this._heading) * 0.5;
        const distance = speed * dt;
        this._x -= Math.sin(midHeading) * distance;
        const forwardDistance = Math.max(0, Math.cos(midHeading) * distance);
        const nextWorldZ = worldZ + forwardDistance;

        // Clamp to the asphalt at the new forward position. The boundary moves
        // with the road, but the car only follows it by actually steering.
        const centreX = roadCenterX(nextWorldZ);
        const lateralHalfExtent = Math.abs(Math.cos(this._heading)) * this.halfWidth
            + Math.abs(Math.sin(this._heading)) * this.halfLength;
        const limit = Math.max(0, cfg.road.halfWidth - lateralHalfExtent);
        const minX = centreX - limit, maxX = centreX + limit;
        const roadHeading = roadHeadingAt(nextWorldZ);
        if (this._x < minX) {
            this._x = minX;
            // The barrier cancels only the part of the heading still pointing
            // out of the road, so steering inward remains immediately usable.
            if (this._heading > roadHeading) this._heading = roadHeading;
            this._againstEdge = true;
        } else if (this._x > maxX) {
            this._x = maxX;
            if (this._heading < roadHeading) this._heading = roadHeading;
            this._againstEdge = true;
        } else this._againstEdge = false;

        // Derive the road plane from the four actual tyre contact locations,
        // not from an axis-aligned centre sample. This is what keeps the body
        // planted when a yawed car crosses a crest or a banked surface.
        const wheel = cfg.car.wheel;
        const wheelX = cfg.car.width / 2 - wheel.width * (0.5 - wheel.outboard);
        const axleZ = this.halfLength * wheel.axleOffset;
        const frontLeft = this._heightAtLocal(-wheelX, -axleZ, nextWorldZ);
        const frontRight = this._heightAtLocal(wheelX, -axleZ, nextWorldZ);
        const rearLeft = this._heightAtLocal(-wheelX, axleZ, nextWorldZ);
        const rearRight = this._heightAtLocal(wheelX, axleZ, nextWorldZ);
        const front = (frontLeft + frontRight) * 0.5;
        const rear = (rearLeft + rearRight) * 0.5;
        const left = (frontLeft + rearLeft) * 0.5;
        const right = (frontRight + rearRight) * 0.5;

        // Rotating about +X tilts the forward axis (-Z) up, so a front higher
        // than the rear is a positive pitch. Negative +Z rotation raises the
        // left tyre, so left-high ground produces negative roll.
        const targetPitch = Math.atan2(front - rear, axleZ * 2);
        const targetRoll = Math.atan2(right - left, wheelX * 2);

        // Road tilt has its own response, so it can stay smooth without forcing
        // the vertical suspension to lag by the same amount.
        const tiltK = 1 - Math.exp(-cfg.car.suspension.tiltResponse * dt);
        this._pitch += (targetPitch - this._pitch) * tiltK;
        this._roll += (targetRoll - this._roll) * tiltK;

        const requiredHeight = this._requiredHeight(nextWorldZ);
        const heightK = 1 - Math.exp(-cfg.car.suspension.heightResponse * dt);
        this._y += (requiredHeight - this._y) * heightK;

        // Bound the damped suspension on both sides: it cannot penetrate rising
        // ground or float visibly when the road falls away beneath it.
        const floor = requiredHeight;
        if (this._y < floor) this._y = floor;
        const ceiling = floor + cfg.car.suspension.maxGroundGap;
        if (this._y > ceiling) this._y = ceiling;

        const obj = this._group.object3D;
        obj.position.set(this._x, this._y, 0);
        // YXZ keeps pitch and roll local to the car after its world-space yaw.
        obj.rotation.set(this._pitch, this._heading, this._roll, 'YXZ');

        this._updateFrontWheelAngles();

        // Roll the tyres. A wheel carrying the car forward (-Z) has its top
        // moving -Z too, which is a NEGATIVE rotation about +X.
        const spin = (speed / cfg.car.wheel.radius) * dt;
        for (const wheel of this._wheels) wheel.rotation.x -= spin;

        return forwardDistance;
    }

    reset(): void {
        this._x = roadCenterX(0);
        this._heading = 0;
        this._steerAngle = 0;
        this._pitch = 0;
        this._roll = 0;
        this._y = this._requiredHeight(0);
        this._againstEdge = false;
        this._group.object3D.position.set(this._x, this._y, 0);
        this._group.object3D.rotation.set(0, 0, 0, 'YXZ');
        for (const wheel of this._wheels) {
            wheel.rotation.x = 0;
            wheel.rotation.y = 0;
        }
    }
}
