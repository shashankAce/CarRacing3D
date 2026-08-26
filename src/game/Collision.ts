import { gameConfig as cfg } from '../config/gameConfig';
import { roadHeadingAt } from '../world/roadPath';
import type { PlayerCar } from './PlayerCar';
import type { TrafficSystem, TrafficVehicle } from './TrafficSystem';

/**
 * Collision — oriented-box overlap between the player and traffic on the XZ
 * plane. The old axis-aligned test was sufficient while player yaw was only a
 * cosmetic few degrees; physical steering can reach the configured heading
 * threshold, where an AABB-style test would miss most of the visible car.
 *
 * Hand-rolled on purpose (ARCHITECTURE.md §5.5). There is one player against at
 * most sixteen obstacles and gameplay is entirely on the ground plane. A
 * physics engine would add a fixed-step simulation and bodies to keep in sync
 * for four projection tests per vehicle.
 *
 * Y is deliberately ignored. Every vehicle sits on the same road surface, so
 * two boxes that overlap in x and z have collided; testing height would only
 * introduce a way to drive through a bus on a slope.
 *
 * Separating-axis checks use each car's right and forward axes. Four scalar
 * tests are enough for two rectangles and keep this allocation-free.
 */
function overlapsOnAxis(
    dx: number,
    dz: number,
    axisX: number,
    axisZ: number,
    aHeading: number,
    aHalfWidth: number,
    aHalfLength: number,
    bHeading: number,
    bHalfWidth: number,
    bHalfLength: number,
): boolean {
    const aRightX = Math.cos(aHeading), aRightZ = Math.sin(aHeading);
    const aForwardX = -Math.sin(aHeading), aForwardZ = Math.cos(aHeading);
    const bRightX = Math.cos(bHeading), bRightZ = Math.sin(bHeading);
    const bForwardX = -Math.sin(bHeading), bForwardZ = Math.cos(bHeading);
    const aRadius = aHalfWidth * Math.abs(axisX * aRightX + axisZ * aRightZ)
        + aHalfLength * Math.abs(axisX * aForwardX + axisZ * aForwardZ);
    const bRadius = bHalfWidth * Math.abs(axisX * bRightX + axisZ * bRightZ)
        + bHalfLength * Math.abs(axisX * bForwardX + axisZ * bForwardZ);
    return Math.abs(dx * axisX + dz * axisZ) <= aRadius + bRadius;
}

export function findCollision(
    car: PlayerCar,
    travelled: number,
    traffic: TrafficSystem,
): TrafficVehicle | null {
    const carX = car.position.x;
    const halfW = car.halfWidth;
    const halfL = car.halfLength;
    const carHeading = car.heading;
    const carRightX = Math.cos(carHeading), carRightZ = Math.sin(carHeading);
    const carForwardX = -Math.sin(carHeading), carForwardZ = Math.cos(carHeading);

    for (const v of traffic.vehicles) {
        if (!v.active) continue;
        const dx = traffic.worldXOf(v) - carX;
        const dz = v.worldZ - travelled;
        const trafficHeading = roadHeadingAt(v.worldZ);
        const trafficRightX = Math.cos(trafficHeading), trafficRightZ = Math.sin(trafficHeading);
        const trafficForwardX = -Math.sin(trafficHeading), trafficForwardZ = Math.cos(trafficHeading);

        if (!overlapsOnAxis(dx, dz, carRightX, carRightZ,
            carHeading, halfW, halfL, trafficHeading, v.halfWidth, v.halfLength)) continue;
        if (!overlapsOnAxis(dx, dz, carForwardX, carForwardZ,
            carHeading, halfW, halfL, trafficHeading, v.halfWidth, v.halfLength)) continue;
        if (!overlapsOnAxis(dx, dz, trafficRightX, trafficRightZ,
            carHeading, halfW, halfL, trafficHeading, v.halfWidth, v.halfLength)) continue;
        if (!overlapsOnAxis(dx, dz, trafficForwardX, trafficForwardZ,
            carHeading, halfW, halfL, trafficHeading, v.halfWidth, v.halfLength)) continue;
        return v;
    }
    return null;
}

/** Score from a completed run. */
export function scoreFor(distance: number, cuts: number): number {
    return Math.floor(distance) + cuts * cfg.scoring.cutBonus;
}
