import * as THREE from 'three';
import { Node, Group3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';

/**
 * Sample offsets along the car's length, as fractions of its half-length, used
 * for the no-penetration test. The two ends matter most; the middle catches a
 * crest passing under the car.
 */
const FOOTPRINT = [-1, -0.5, 0, 0.5, 1];

/**
 * PlayerCar — placeholder box car, its steering, and how it sits on the ground.
 *
 * Forward motion is the world scrolling past (see WorldScroll), so the car's own
 * driving state is one number: `_x`, its ABSOLUTE lateral world position.
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
 * What's here is absolute x, clamped to the road edges — where the clamp
 * boundary MOVES with the road. That distinction is the whole thing: the car
 * never drifts sideways on its own, so holding a bend takes steering, and
 * reaching an edge is a collision that shoves the car along like a barrier.
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
    /** Lateral velocity, m/s. */
    private _vx = 0;
    /** Absolute lateral world position, metres. */
    private _x = 0;
    /** Damped ride height, pitch and roll — the suspension's state. */
    private _y = 0;
    private _pitch = 0;
    private _roll = 0;
    /** True while the car is pinned against a road edge. */
    private _againstEdge = false;

    /** Read by the follow camera. */
    get position(): THREE.Vector3 { return this._group.position; }
    get lateralSpeedT(): number { return this._vx / cfg.steering.maxLateralSpeed; }

    /**
     * True while the car is scraping a road edge. Nothing consumes it yet —
     * it's the hook for Phase 4 to add a scrape sound, a speed penalty, or
     * sparks, whichever the design lands on.
     */
    get isAgainstEdge(): boolean { return this._againstEdge; }

    /** Half-extents used for ground sampling and (Phase 4) collision. */
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
        body.position.y = c.rideHeight + c.height / 2;

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(c.width * c.cabinWidthFactor, c.cabinHeight, c.length * c.cabinLengthFactor),
            new THREE.MeshStandardMaterial({ color: cfg.colors.car.cabin, roughness: 0.35, metalness: 0.2 }),
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

    /**
     * The lowest the car's body can sit at `pitch` without any part of its
     * underside passing through the ground.
     *
     * Using the ground height under the car's CENTRE is wrong, and visibly so:
     * a rigid body in a dip rests on its ends, not its middle, so centre-height
     * buried the body — the rear especially, since damping lag left it
     * misaligned on a grade. Taking the maximum over the footprint gives the
     * real resting height: on a crest that reduces to the centre (the car
     * bridges it), in a dip it lifts to the ends, and on a constant grade the
     * `s·sin(pitch)` term cancels the slope so it reduces to the centre again.
     */
    private _requiredHeight(worldZ: number, pitch: number): number {
        const hl = this.halfLength;
        const sinPitch = Math.sin(pitch);
        let required = -Infinity;
        for (const f of FOOTPRINT) {
            // Local +z is toward the rear, so a point at local z = s sits at
            // world z = worldZ - s, and its underside is at y - s·sin(pitch).
            const s = f * hl;
            const need = surfaceHeightAt(this._x, worldZ - s) + s * sinPitch;
            if (need > required) required = need;
        }
        return required;
    }

    /**
     * @param axis    -1 … +1 from InputController.
     * @param worldZ  The car's absolute world Z — i.e. `scroll.travelled`, since
     *                the car always renders at z ≈ 0.
     * @param speed   Forward speed, m/s — spins the wheels.
     */
    update(dt: number, axis: number, worldZ: number, speed: number): void {
        const s = cfg.steering;

        // Exponential damping toward the target velocity — frame-rate
        // independent, unlike a fixed per-frame lerp factor.
        const targetVx = axis * s.maxLateralSpeed;
        this._vx += (targetVx - this._vx) * (1 - Math.exp(-s.response * dt));

        // Clamp to the asphalt. The limits are computed from the road centre at
        // the car's own z, so they TRACK the curve — but the car's position
        // doesn't, which is what forces the player to steer.
        this._x += this._vx * dt;
        const centreX = roadCenterX(worldZ);
        const limit = cfg.road.halfWidth - this.halfWidth;
        const minX = centreX - limit, maxX = centreX + limit;
        if (this._x < minX) { this._x = minX; this._vx = 0; this._againstEdge = true; }
        else if (this._x > maxX) { this._x = maxX; this._vx = 0; this._againstEdge = true; }
        else this._againstEdge = false;

        const hw = this.halfWidth, hl = this.halfLength;
        const front = surfaceHeightAt(this._x, worldZ + hl);
        const rear = surfaceHeightAt(this._x, worldZ - hl);
        const left = surfaceHeightAt(this._x - hw, worldZ);
        const right = surfaceHeightAt(this._x + hw, worldZ);

        // Rotating about +X tilts the forward axis (-Z) up, so a front higher
        // than the rear is a positive pitch. Rotating about +Z tilts the roof
        // toward -X, so ground higher on the left is also positive.
        const targetPitch = Math.atan2(front - rear, cfg.car.length);
        const targetRoll = Math.atan2(left - right, cfg.car.width);

        // Suspension. Terrain's smallest octave is a 24m wavelength, which at
        // top speed is ~3 bumps a second — read undamped, the car vibrates.
        const k = 1 - Math.exp(-cfg.car.suspensionRate * dt);
        this._pitch += (targetPitch - this._pitch) * k;
        this._roll += (targetRoll - this._roll) * k;
        this._y += (this._requiredHeight(worldZ, this._pitch) - this._y) * k;

        // Damping may settle DOWN toward the target, which is what a suspension
        // should do as ground falls away — but it must never settle down THROUGH
        // the ground. The required height is computed against the pitch actually
        // in use, not the target, so a lagging pitch can't open a gap either.
        const floor = this._requiredHeight(worldZ, this._pitch);
        if (this._y < floor) this._y = floor;

        const obj = this._group.object3D;
        obj.position.set(this._x, this._y, 0);
        obj.rotation.x = this._pitch;
        // Steering yaw and roll are cosmetic, and stack on the ground's own tilt.
        // The car does NOT take the road's heading — its nose points where the
        // player is steering, not where the road happens to go.
        const t = this.lateralSpeedT;
        obj.rotation.y = -t * cfg.steering.yawFactor;
        obj.rotation.z = this._roll + t * cfg.steering.rollFactor;

        // Roll the tyres. A wheel carrying the car forward (-Z) has its top
        // moving -Z too, which is a NEGATIVE rotation about +X.
        const spin = (speed / cfg.car.wheel.radius) * dt;
        for (const wheel of this._wheels) wheel.rotation.x -= spin;
    }

    reset(): void {
        this._vx = 0;
        this._x = roadCenterX(0);
        this._pitch = 0;
        this._roll = 0;
        this._y = this._requiredHeight(0, 0);
        this._againstEdge = false;
        this._group.object3D.position.set(this._x, this._y, 0);
        this._group.object3D.rotation.set(0, 0, 0);
        for (const wheel of this._wheels) wheel.rotation.x = 0;
    }
}
