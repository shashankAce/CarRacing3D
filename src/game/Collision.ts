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
 * Both bodies are tested at their own z. The visual yaw from `roadHeadingAt`
 * and the player's steering tilt are NOT accounted for — the boxes stay
 * axis-aligned. At the road's ~11° maximum heading that understates a car's
 * true footprint by a few centimetres, which is the right way to be wrong:
 * collisions read as slightly forgiving rather than as phantom hits.
 */
export function findCollision(
    car: PlayerCar,
    travelled: number,
    traffic: TrafficSystem,
): TrafficVehicle | null {
    const carX = car.position.x;
    const halfW = car.halfWidth;
    const halfL = car.halfLength;

    for (const v of traffic.vehicles) {
        if (!v.active) continue;
        if (Math.abs(v.worldZ - travelled) > v.halfLength + halfL) continue;
        if (Math.abs(traffic.worldXOf(v) - carX) > v.halfWidth + halfW) continue;
        return v;
    }
    return null;
}

/** Score from a completed run. */
export function scoreFor(distance: number, cuts: number): number {
    return Math.floor(distance) + cuts * cfg.scoring.cutBonus;
}
