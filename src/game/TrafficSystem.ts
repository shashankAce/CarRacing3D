import * as THREE from 'three';
import { Node, Mesh3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadHeadingAt, roadPitchAt } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';

/** One pooled vehicle. Never created or destroyed after startup. */
export interface TrafficVehicle {
    mesh: Mesh3D;
    active: boolean;
    /** Index into `cfg.traffic.types`. */
    type: number;
    lane: number;
    /** Absolute world Z, like everything else in the world. */
    worldZ: number;
    /** Forward speed, m/s. Slower than the player, hence the overtaking. */
    speed: number;
    /** Set once this vehicle has been counted as cut, so it can't score twice. */
    counted: boolean;
    /** Cached from its type, for collision and placement. */
    halfWidth: number;
    halfLength: number;
    height: number;
}

/**
 * TrafficSystem — the vehicles to weave through.
 *
 * A fixed pool, allocated once and recycled: nothing is created or destroyed
 * while driving. Each vehicle is a single box (the brief calls for coloured
 * boxes until real models land) sharing ONE unit BoxGeometry, scaled per type,
 * with one shared material per type — so a vehicle costs one draw call and the
 * pool costs four materials. Deliberately not what `PlayerCar` does with its six
 * separate meshes; sixteen vehicles built that way would be ~96 draw calls.
 *
 * Vehicles use the same three road functions the player and the lane markers do
 * — `roadCenterX` for lane position, `surfaceHeightAt` for ride height (NOT
 * `heightAt`, which is the terrain under the asphalt), and
 * `roadPitchAt`/`roadHeadingAt` for orientation — so they sit on the road
 * correctly through curves and over crests without any code of their own.
 */
export class TrafficSystem {

    private _pool: TrafficVehicle[] = [];
    private _materials: THREE.MeshStandardMaterial[] = [];
    /** Player travel at which the next spawn is attempted. */
    private _nextSpawnAt = 0;
    private _totalWeight = 0;

    /** Vehicles the player has cut past this run. */
    cuts = 0;

    get vehicles(): readonly TrafficVehicle[] { return this._pool; }

    constructor(scene: Scene) {
        const t = cfg.traffic;
        // One geometry for every vehicle: a unit cube, scaled per type. Sharing
        // it means the whole pool is one geometry upload.
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const materials = t.types.map(type => new THREE.MeshStandardMaterial({
            color: type.color, roughness: 0.5, metalness: 0.15,
        }));
        for (const type of t.types) this._totalWeight += type.weight;

        for (let i = 0; i < t.maxAlive; i++) {
            const node = new Node();
            const mesh = node.addComponent(Mesh3D);
            mesh.geometry = geometry;
            mesh.material = materials[0];
            scene.addChild(node);
            mesh.object3D.visible = false;
            this._pool.push({
                mesh, active: false, type: 0, lane: 0, worldZ: 0, speed: 0,
                counted: false, halfWidth: 0, halfLength: 0, height: 0,
            });
        }
        this._materials = materials;
        this.reset();
    }

    /** Lateral centre of a lane, as an offset from the road centre. */
    static laneOffset(lane: number): number {
        const laneWidth = (cfg.road.halfWidth * 2) / cfg.traffic.laneCount;
        return -cfg.road.halfWidth + laneWidth * (lane + 0.5);
    }

    /**
     * Clears the road and re-seeds it. `travelled` is the player's world Z for
     * the new run (0 on a restart), so seeding is relative to wherever they are.
     */
    reset(travelled = 0): void {
        for (const v of this._pool) {
            v.active = false;
            v.mesh.object3D.visible = false;
        }
        this.cuts = 0;
        this._nextSpawnAt = travelled + cfg.traffic.spawnGapSlow;

        // Seed the visible road, so the player has traffic to deal with within
        // a few seconds rather than waiting out the closing speed from
        // `spawnAhead`. Bounded attempts, since the lane rules can reject a
        // placement and there's no guarantee of ever finding `seedCount` slots.
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
        // ── Advance and recycle ───────────────────────────────────────────
        for (const v of this._pool) {
            if (!v.active) continue;
            v.worldZ += v.speed * dt;

            // One cut per vehicle, credited the moment the player draws level.
            // `counted` is the guard — without it a vehicle sitting near the
            // player's z would score every frame.
            if (!v.counted && travelled > v.worldZ) {
                v.counted = true;
                this.cuts++;
            }

            // Recycled in BOTH directions — see `despawnAhead` on why the
            // forward test isn't optional.
            if (v.worldZ < travelled - cfg.traffic.despawnBehind
                || v.worldZ > travelled + cfg.traffic.despawnAhead) {
                v.active = false;
                v.mesh.object3D.visible = false;
                continue;
            }
            this._place(v, travelled);
        }

        // ── Spawn ────────────────────────────────────────────────────────
        if (travelled >= this._nextSpawnAt) {
            this._placeAt(travelled + cfg.traffic.spawnAhead, travelled);
            const t = cfg.traffic;
            const gap = t.spawnGapSlow + (t.spawnGapFast - t.spawnGapSlow) * speedT;
            this._nextSpawnAt = travelled + gap;
        }
    }

    private _place(v: TrafficVehicle, travelled: number): void {
        const x = this.worldXOf(v);
        const obj = v.mesh.object3D;
        obj.position.set(
            x,
            surfaceHeightAt(x, v.worldZ) + v.height / 2,
            travelled - v.worldZ,
        );
        obj.rotation.x = roadPitchAt(v.worldZ, v.halfLength * 2);
        obj.rotation.y = roadHeadingAt(v.worldZ);
    }

    /**
     * Places one vehicle at `spawnZ` if the lane rules allow it. Shared by the
     * running spawn and by the seeding in `reset`, so both obey the same spacing
     * and fairness rules.
     */
    private _placeAt(spawnZ: number, travelled: number): boolean {
        const t = cfg.traffic;
        const slot = this._pool.find(v => !v.active);
        if (!slot) return false;                 // pool full — density is capped

        // Which lanes are usable at all, and how many are clear nearby. The
        // second number is the fairness guard: never leave fewer than
        // `minFreeLanes` open, or the player can meet an impassable wall.
        const free: number[] = [];
        let clearNearby = 0;
        for (let lane = 0; lane < t.laneCount; lane++) {
            const occupiedAtSpawn = this._pool.some(v =>
                v.active && v.lane === lane && Math.abs(v.worldZ - spawnZ) < t.minLaneGap);
            const occupiedNearby = this._pool.some(v =>
                v.active && v.lane === lane && Math.abs(v.worldZ - spawnZ) < t.freeLaneCheckRange);
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
        slot.lane = lane;
        slot.worldZ = spawnZ;
        slot.speed = spec.speedMin + Math.random() * (spec.speedMax - spec.speedMin);
        slot.halfWidth = spec.width / 2;
        slot.halfLength = spec.length / 2;
        slot.height = spec.height;

        slot.mesh.material = this._materials[type];
        const obj = slot.mesh.object3D;
        obj.scale.set(spec.width, spec.height, spec.length);
        obj.visible = true;
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

    /**
     * World x of a vehicle, from its lane and the road's centre at its own z.
     * Public because collision needs it too, and it must be the same number the
     * mesh was placed at.
     */
    worldXOf(v: TrafficVehicle): number {
        return roadCenterX(v.worldZ) + TrafficSystem.laneOffset(v.lane);
    }
}
