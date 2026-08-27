import { gameConfig as cfg } from '../config/gameConfig';
import type { PlayerCar } from './PlayerCar';
import type { TrafficSystem, TrafficVehicle } from './TrafficSystem';

/**
 * Collision — axis-aligned overlap between the player and traffic, on the XZ
 * plane.
 *
 * Hand-rolled on purpose (ARCHITECTURE.md §5.5). Everything here is
 * axis-aligned, there is one player against at most sixteen obstacles, and the
 * gameplay is entirely on the ground plane — so this is two interval tests per
 * vehicle. A physics engine would add a fixed-step simulation, bodies to keep in
 * sync, and (for Rapier) 1.5MB of WASM against a 2MB budget, in exchange for
 * nothing this game asks for.
 *
 * Y is deliberately ignored. Every vehicle sits on the same road surface, so
 * two boxes that overlap in x and z have collided; testing height would only
 * introduce a way to drive through a bus on a slope.
 *
 * Both bodies are tested at their own z. Their boxes stay axis-aligned, but
 * each half-extent is expanded by the body's current yaw so the AABB encloses
 * the complete rotated footprint. This matters both while the player steers
 * and while traffic follows a curve or changes lanes: the collision box must
 * never become smaller than the visible car.
 */
export function findCollision(
    car: PlayerCar,
    travelled: number,
    traffic: TrafficSystem,
): TrafficVehicle | null {
    const carX = car.position.x;
    const carWorldZ = travelled - car.position.z;
    const carYaw = car.rotationY;
    const carCos = Math.abs(Math.cos(carYaw));
    const carSin = Math.abs(Math.sin(carYaw));
    const carHalfW = car.halfWidth * carCos + car.halfLength * carSin;
    const carHalfL = car.halfWidth * carSin + car.halfLength * carCos;

    for (const v of traffic.vehicles) {
        if (!v.active) continue;
        const trafficYaw = v.group.object3D.rotation.y;
        const trafficCos = Math.abs(Math.cos(trafficYaw));
        const trafficSin = Math.abs(Math.sin(trafficYaw));
        const trafficHalfW = v.halfWidth * trafficCos + v.halfLength * trafficSin;
        const trafficHalfL = v.halfWidth * trafficSin + v.halfLength * trafficCos;

        if (Math.abs(v.worldZ - carWorldZ) > trafficHalfL + carHalfL) continue;
        if (Math.abs(traffic.worldXOf(v) - carX) > trafficHalfW + carHalfW) continue;
        return v;
    }
    return null;
}

/** Score from a completed run. */
export function scoreFor(distance: number, cuts: number): number {
    return Math.floor(distance) + cuts * cfg.scoring.cutBonus;
}
