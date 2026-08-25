import * as THREE from 'three';
import { Node, Group3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadHeadingAt, roadPitchAt } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';

/** What a vehicle is doing about the one in front. */
const enum Manoeuvre {
    CRUISING = 0,
    SIGNALLING = 1,
    CHANGING = 2,
}

/** One pooled vehicle. Never created or destroyed after startup. */
export interface TrafficVehicle {
    group: Group3D;
    body: THREE.Mesh;
    indicator: THREE.Mesh;
    active: boolean;
    /** Index into `cfg.traffic.types`. */
    type: number;
    /**
     * Lateral position as a FRACTIONAL lane index, so a lane change is a smooth
     * slide rather than a jump. Occupancy tests round it.
     */
    laneF: number;
    targetLane: number;
    /** Absolute world Z, like everything else in the world. */
    worldZ: number;
    /** What it wants to do, and what it's actually doing while blocked. */
    desiredSpeed: number;
    speed: number;
    manoeuvre: Manoeuvre;
    signalTimer: number;
    /** -1 signalling/moving left, +1 right, 0 not signalling. */
    signalDir: number;
    /** Set once this vehicle has been counted as cut, so it can't score twice. */
    counted: boolean;
    /** Cached from its type, for collision and placement. */
    halfWidth: number;
    halfLength: number;
    height: number;
}

/**
 * TrafficSystem — the vehicles to weave through, and their own traffic sense.
 *
 * A fixed pool, allocated once and recycled: nothing is created or destroyed
 * while driving. Each vehicle is a Group3D holding a body box (shared unit
 * BoxGeometry, scaled per type, one shared material per type) and an indicator
 * light. A group rather than a bare mesh specifically because the body carries a
 * non-uniform scale — hanging the indicator off the body directly would stretch
 * it by the vehicle's proportions.
 *
 * Vehicles use the same road functions the player and the lane markers do —
 * `roadCenterX` for lane position, `surfaceHeightAt` for ride height (NOT
 * `heightAt`, which is the terrain under the asphalt), and
 * `roadPitchAt`/`roadHeadingAt` for orientation — so they sit on the road
 * correctly through curves and over crests without any code of their own.
 *
 * There is no traffic-vs-traffic collision. The overtake logic is what keeps
 * vehicles apart, which is why it has to handle the blocked case by slowing
 * down: a vehicle that can't change lanes and doesn't brake drives through the
 * one in front.
 */
export class TrafficSystem {

    private _pool: TrafficVehicle[] = [];
    private _materials: THREE.MeshStandardMaterial[] = [];
    /** Player travel at which the next spawn is attempted. */
    private _nextSpawnAt = 0;
    private _totalWeight = 0;
    /** Drives indicator blinking; shared so every signal blinks in phase. */
    private _blinkClock = 0;

    /** Vehicles the player has cut past this run. */
    cuts = 0;

    get vehicles(): readonly TrafficVehicle[] { return this._pool; }

    constructor(scene: Scene) {
        const t = cfg.traffic;
        // One geometry for every vehicle: a unit cube, scaled per type. Sharing
        // it means the whole pool is one geometry upload.
        const bodyGeometry = new THREE.BoxGeometry(1, 1, 1);
        const indicatorGeometry = new THREE.BoxGeometry(1, 1, 1);
        const indicatorMaterial = new THREE.MeshBasicMaterial({ color: t.overtake.indicatorColor });
        this._materials = t.types.map(type => new THREE.MeshStandardMaterial({
            color: type.color, roughness: 0.5, metalness: 0.15,
        }));
        for (const type of t.types) this._totalWeight += type.weight;

        for (let i = 0; i < t.maxAlive; i++) {
            const node = new Node();
            const group = node.addComponent(Group3D);
            scene.addChild(node);

            const body = new THREE.Mesh(bodyGeometry, this._materials[0]);
            body.castShadow = cfg.lighting.shadows.enabled;

            // Unlit, so it reads as a lamp rather than a painted panel — and it
            // stays visible on the shadowed side of a vehicle.
            const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
            indicator.visible = false;

            group.object3D.add(body, indicator);
            group.object3D.visible = false;

            this._pool.push({
                group, body, indicator, active: false, type: 0,
                laneF: 0, targetLane: 0, worldZ: 0,
                desiredSpeed: 0, speed: 0,
                manoeuvre: Manoeuvre.CRUISING, signalTimer: 0, signalDir: 0,
                counted: false, halfWidth: 0, halfLength: 0, height: 0,
            });
        }
        this.reset();
    }

    /** Lateral centre of a lane, as an offset from the road centre. Linear in `lane`, so fractional lanes interpolate. */
    static laneOffset(lane: number): number {
        const laneWidth = (cfg.road.halfWidth * 2) / cfg.traffic.laneCount;
        return -cfg.road.halfWidth + laneWidth * (lane + 0.5);
    }

    /**
     * World x of a vehicle, from its lane and the road's centre at its own z.
     * Public because collision needs it too, and it must be the same number the
     * mesh was placed at.
     */
    worldXOf(v: TrafficVehicle): number {
        return roadCenterX(v.worldZ) + TrafficSystem.laneOffset(v.laneF);
    }

    reset(travelled = 0): void {
        for (const v of this._pool) {
            v.active = false;
            v.group.object3D.visible = false;
            v.indicator.visible = false;
        }
        this.cuts = 0;
        this._nextSpawnAt = travelled + cfg.traffic.spawnGapSlow;

        const t = cfg.traffic;
        let placed = 0;
        for (let attempt = 0; attempt < t.seedCount * 6 && placed < t.seedCount; attempt++) {
            const z = travelled + t.seedMinAhead
                + Math.random() * (t.spawnAhead - t.seedMinAhead);
            if (this._placeAt(z, travelled)) placed++;
        }
    }

    /**
     * @param travelled Player's absolute world Z.
     * @param speedT    0…1 through the speed ramp — tightens the spawn spacing.
     */
    update(dt: number, travelled: number, speedT: number): void {
        this._blinkClock += dt;

        for (const v of this._pool) {
            if (!v.active) continue;
            this._think(v, dt);
            v.worldZ += v.speed * dt;

            // One cut per vehicle, credited the moment the player draws level.
            if (!v.counted && travelled > v.worldZ) {
                v.counted = true;
                this.cuts++;
            }

            // Recycled in BOTH directions — see `despawnAhead` on why the
            // forward test isn't optional.
            if (v.worldZ < travelled - cfg.traffic.despawnBehind
                || v.worldZ > travelled + cfg.traffic.despawnAhead) {
                v.active = false;
                v.group.object3D.visible = false;
                continue;
            }
            this._place(v, travelled);
        }

        if (travelled >= this._nextSpawnAt) {
            this._placeAt(travelled + cfg.traffic.spawnAhead, travelled);
            const t = cfg.traffic;
            const gap = t.spawnGapSlow + (t.spawnGapFast - t.spawnGapSlow) * speedT;
            this._nextSpawnAt = travelled + gap;
        }
    }

    /**
     * One vehicle's decision for this frame: notice a slower vehicle ahead, and
     * either signal-then-change lane, or slow to match if nowhere is free.
     */
    private _think(v: TrafficVehicle, dt: number): void {
        const o = cfg.traffic.overtake;

        // Progress an in-flight manoeuvre first.
        if (v.manoeuvre === Manoeuvre.SIGNALLING) {
            v.signalTimer -= dt;
            if (v.signalTimer <= 0) v.manoeuvre = Manoeuvre.CHANGING;
        } else if (v.manoeuvre === Manoeuvre.CHANGING) {
            const step = o.laneChangeSpeed * dt;
            const remaining = v.targetLane - v.laneF;
            if (Math.abs(remaining) <= step) {
                v.laneF = v.targetLane;
                v.manoeuvre = Manoeuvre.CRUISING;
                v.signalDir = 0;
            } else {
                v.laneF += Math.sign(remaining) * step;
            }
        }

        const blocker = this._blockerAhead(v);

        // Speed: match a blocker that's close, otherwise recover toward desired.
        const target = blocker && (blocker.worldZ - v.worldZ) < o.safeGap
            ? Math.min(v.desiredSpeed, blocker.speed)
            : v.desiredSpeed;
        const rate = o.matchRate * dt;
        v.speed += Math.max(-rate, Math.min(rate, target - v.speed));

        // Only look for a way past while cruising — committing to a second
        // manoeuvre mid-change is how vehicles end up straddling lanes.
        if (v.manoeuvre !== Manoeuvre.CRUISING || !blocker) return;
        if ((blocker.worldZ - v.worldZ) > o.safeGap) return;

        const lane = Math.round(v.laneF);
        // Prefer the left lane (lower index) first, then the right — an
        // arbitrary but consistent preference beats a random one, which would
        // make two vehicles behind the same blocker pick differently and swap.
        for (const dir of [-1, 1]) {
            const candidate = lane + dir;
            if (candidate < 0 || candidate >= cfg.traffic.laneCount) continue;
            if (!this._laneIsClear(v, candidate)) continue;
            v.targetLane = candidate;
            v.manoeuvre = Manoeuvre.SIGNALLING;
            v.signalTimer = o.signalTime;
            v.signalDir = dir;
            return;
        }
    }

    /** The nearest slower vehicle ahead in this vehicle's own lane, if any. */
    private _blockerAhead(v: TrafficVehicle): TrafficVehicle | null {
        const o = cfg.traffic.overtake;
        let best: TrafficVehicle | null = null;
        let bestGap = Infinity;
        for (const other of this._pool) {
            if (!other.active || other === v) continue;
            // Same lane means overlapping laterally, which during a lane change
            // includes the lane being crossed.
            if (Math.abs(other.laneF - v.laneF) > 0.6) continue;
            const gap = other.worldZ - v.worldZ;
            if (gap <= 0 || gap > o.lookahead) continue;
            if (other.speed >= v.speed - 0.5) continue;   // not actually slower
            if (gap < bestGap) { bestGap = gap; best = other; }
        }
        return best;
    }

    /** Whether `lane` has room for `v` to move into, ahead and behind. */
    private _laneIsClear(v: TrafficVehicle, lane: number): boolean {
        const o = cfg.traffic.overtake;
        for (const other of this._pool) {
            if (!other.active || other === v) continue;
            if (Math.abs(other.laneF - lane) > 0.6) continue;
            const gap = other.worldZ - v.worldZ;
            if (gap >= 0 && gap < o.minGapAhead) return false;
            if (gap < 0 && -gap < o.minGapBehind) return false;
        }
        return true;
    }

    private _place(v: TrafficVehicle, travelled: number): void {
        const x = this.worldXOf(v);
        const obj = v.group.object3D;
        obj.position.set(
            x,
            surfaceHeightAt(x, v.worldZ) + v.height / 2,
            travelled - v.worldZ,
        );
        obj.rotation.x = roadPitchAt(v.worldZ, v.halfLength * 2);
        obj.rotation.y = roadHeadingAt(v.worldZ);

        // Blink only while signalling or mid-change, on the side being moved to.
        if (v.signalDir === 0) {
            v.indicator.visible = false;
        } else {
            const s = cfg.traffic.overtake.indicatorSize;
            // Rear corner of the side being signalled. Local +Z is the rear,
            // since forward is -Z. Nudged clear of the body so it isn't half
            // buried in it.
            v.indicator.position.set(
                v.signalDir * (v.halfWidth - s * 0.4),
                v.height * 0.1,
                v.halfLength + s * 0.3,
            );
            const phase = Math.floor(this._blinkClock * cfg.traffic.overtake.blinkHz * 2) % 2;
            v.indicator.visible = phase === 0;
        }
    }

    private _placeAt(spawnZ: number, travelled: number): boolean {
        const t = cfg.traffic;
        const slot = this._pool.find(v => !v.active);
        if (!slot) return false;                 // pool full — density is capped

        const free: number[] = [];
        let clearNearby = 0;
        for (let lane = 0; lane < t.laneCount; lane++) {
            const occupiedAtSpawn = this._pool.some(v =>
                v.active && Math.round(v.laneF) === lane && Math.abs(v.worldZ - spawnZ) < t.minLaneGap);
            const occupiedNearby = this._pool.some(v =>
                v.active && Math.round(v.laneF) === lane && Math.abs(v.worldZ - spawnZ) < t.freeLaneCheckRange);
            if (!occupiedAtSpawn) free.push(lane);
            if (!occupiedNearby) clearNearby++;
        }
        if (free.length === 0) return false;
        // Spawning here would drop the clear-lane count below the guarantee.
        if (clearNearby - 1 < t.minFreeLanes) return false;

        const lane = free[Math.floor(Math.random() * free.length)];
        const type = this._pickType();
        const spec = t.types[type];

        slot.active = true;
        slot.counted = false;
        slot.type = type;
        slot.laneF = lane;
        slot.targetLane = lane;
        slot.worldZ = spawnZ;
        slot.desiredSpeed = spec.speedMin + Math.random() * (spec.speedMax - spec.speedMin);
        slot.speed = slot.desiredSpeed;
        slot.manoeuvre = Manoeuvre.CRUISING;
        slot.signalTimer = 0;
        slot.signalDir = 0;
        slot.halfWidth = spec.width / 2;
        slot.halfLength = spec.length / 2;
        slot.height = spec.height;

        slot.body.material = this._materials[type];
        slot.body.scale.set(spec.width, spec.height, spec.length);

        // Indicator on the rear face, offset to whichever side is being signalled
        // — repositioned when a manoeuvre starts, so one mesh covers both sides.
        const s = t.overtake.indicatorSize;
        slot.indicator.scale.set(s, s, s * 0.5);

        slot.group.object3D.visible = true;
        slot.indicator.visible = false;
        this._place(slot, travelled);
        return true;
    }

    /** Weighted pick over the type table. */
    private _pickType(): number {
        let r = Math.random() * this._totalWeight;
        const types = cfg.traffic.types;
        for (let i = 0; i < types.length; i++) {
            r -= types[i].weight;
            if (r <= 0) return i;
        }
        return types.length - 1;
    }
}
