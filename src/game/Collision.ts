import { gameConfig as cfg } from '../config/gameConfig';
import type { PlayerCar } from './PlayerCar';
import type { TrafficSystem, TrafficVehicle } from './TrafficSystem';

export interface CollisionRect {
    x: number;
    z: number;
    halfWidth: number;
    halfLength: number;
    yaw: number;
}

export type CollisionBody = 'player' | 'traffic';

/** Fills an OBB using the independently tunable fraction of its visual bounds. */
export function setCollisionRect(
    out: CollisionRect,
    body: CollisionBody,
    x: number,
    z: number,
    visualHalfWidth: number,
    visualHalfLength: number,
    yaw: number,
): CollisionRect {
    const tuning = cfg.collision[body];
    out.x = x;
    out.z = z;
    out.halfWidth = visualHalfWidth * tuning.widthScale;
    out.halfLength = visualHalfLength * tuning.lengthScale;
    out.yaw = yaw;
    return out;
}

/** Exact 2D oriented-box overlap using the four SAT separating axes. */
export function orientedBoxesOverlap(a: CollisionRect, b: CollisionRect): boolean {
    const ac = Math.cos(a.yaw), as = Math.sin(a.yaw);
    const bc = Math.cos(b.yaw), bs = Math.sin(b.yaw);

    // Each box's local width and length axes in world XZ.
    const aux = ac, auz = -as, avx = as, avz = ac;
    const bux = bc, buz = -bs, bvx = bs, bvz = bc;

    // B's axes expressed in A's frame.
    const r00 = aux * bux + auz * buz;
    const r01 = aux * bvx + auz * bvz;
    const r10 = avx * bux + avz * buz;
    const r11 = avx * bvx + avz * bvz;
    // Tiny epsilon keeps nearly parallel boxes stable at exact contact.
    const ar00 = Math.abs(r00) + 1e-8, ar01 = Math.abs(r01) + 1e-8;
    const ar10 = Math.abs(r10) + 1e-8, ar11 = Math.abs(r11) + 1e-8;

    const dx = b.x - a.x, dz = b.z - a.z;
    const t0 = dx * aux + dz * auz;
    const t1 = dx * avx + dz * avz;

    // A width axis, A length axis, B width axis, B length axis.
    if (Math.abs(t0) > a.halfWidth + b.halfWidth * ar00 + b.halfLength * ar01) return false;
    if (Math.abs(t1) > a.halfLength + b.halfWidth * ar10 + b.halfLength * ar11) return false;
    if (Math.abs(t0 * r00 + t1 * r10)
        > b.halfWidth + a.halfWidth * ar00 + a.halfLength * ar10) return false;
    if (Math.abs(t0 * r01 + t1 * r11)
        > b.halfLength + a.halfWidth * ar01 + a.halfLength * ar11) return false;
    return true;
}

const _carRect: CollisionRect = { x: 0, z: 0, halfWidth: 0, halfLength: 0, yaw: 0 };
const _trafficRect: CollisionRect = { x: 0, z: 0, halfWidth: 0, halfLength: 0, yaw: 0 };

/**
 * Collision — oriented rectangle overlap between the player and traffic on XZ.
 *
 * Hand-rolled on purpose (ARCHITECTURE.md §5.5). There is one player against a
 * tiny fixed traffic pool and gameplay is entirely on the ground plane, so four
 * separating-axis tests per vehicle are substantially cheaper and simpler than
 * keeping a full physics simulation in sync.
 *
 * Y is deliberately ignored. Every vehicle sits on the same road surface, so
 * two boxes that overlap in x and z have collided; testing height would only
 * introduce a way to drive through a bus on a slope.
 *
 * Both boxes rotate with their vehicles. SAT tests the two local axes from
 * each rectangle, avoiding the false positives produced by the old expanded
 * AABB when a car was steering or traffic was following a bend.
 *
 * Centres and yaw MUST come from the same coordinate space. Render Z mirrors
 * world Z (`renderZ = travelled - worldZ`), which also mirrors yaw. Mixing
 * absolute world-Z centres with render-space object yaw made SAT disagree with
 * the visible/debug boxes. Reading both from current render transforms keeps
 * collision exactly on the frame the player sees.
 */
export function findCollision(
    car: PlayerCar,
    traffic: TrafficSystem,
): TrafficVehicle | null {
    setCollisionRect(
        _carRect, 'player', car.position.x, car.position.z,
        car.halfWidth, car.halfLength, car.rotationY,
    );

    for (const v of traffic.vehicles) {
        if (!v.active) continue;
        const trafficTransform = v.group.object3D;
        setCollisionRect(
            _trafficRect, 'traffic', trafficTransform.position.x, trafficTransform.position.z,
            v.halfWidth, v.halfLength, trafficTransform.rotation.y,
        );
        if (orientedBoxesOverlap(_carRect, _trafficRect)) return v;
    }
    return null;
}

/** Score from a completed run. */
export function scoreFor(distance: number, cuts: number): number {
    return Math.floor(distance) + cuts * cfg.scoring.cutBonus;
}
