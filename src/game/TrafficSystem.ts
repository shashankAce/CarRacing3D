import * as THREE from 'three';
import { Node, Group3D, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadHeadingAt } from '../world/roadPath';
import { surfaceHeightAt } from '../procedural/heightField';
import type { ProjectedShadows } from '../world/ProjectedShadows';
import type { VehicleModels } from '../assets/VehicleModels';

/** What a vehicle is doing about the one in front. */
const enum Manoeuvre {
    CRUISING = 0,
    SIGNALLING = 1,
    CHANGING = 2,
}

/** One pooled vehicle. Never created or destroyed after startup. */
export interface TrafficVehicle {
    group: Group3D;
    /** Hidden collision/shadow proxy retained for the existing pooled logic. */
    body: THREE.Mesh;
    /** The static FBX visual assigned to this pool slot's configured type. */
    model: THREE.Object3D | null;
    /** Reduced version of this same FBX used outside the full-detail radius. */
    lodModel: THREE.Object3D | null;
    /** Custom-wheel animation for the full and distant visual tiers. */
    spinWheels: (distance: number) => void;
    spinLodWheels: (distance: number) => void;
    /** Cached to avoid toggling child visibility when a vehicle remains in one tier. */
    fullDetail: boolean;
    /** Fixed per pool slot, so spawning never allocates a new model. */
    modelType: number;
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
    /** Smoothed yaw relative to the road heading while changing lanes. */
    laneYaw: number;
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
 * `heightAt`, which is the terrain under the asphalt), and `roadHeadingAt` for
 * orientation. Ride height, pitch and roll come from the vehicle's yawed
 * footprint, so its full body stays supported through curves, slopes and
 * crests instead of floating from a single centre-height sample.
 *
 * There is no traffic-vs-traffic collision. The overtake logic is what keeps
 * vehicles apart, which is why it has to handle the blocked case by slowing
 * down: a vehicle that can't change lanes and doesn't brake drives through the
 * one in front.
 */
export class TrafficSystem {

    private _pool: TrafficVehicle[] = [];
    private _materials: THREE.Material[] = [];
    /** Materials grouped by caster type, for type-level projected self-skip. */
    private _materialsByType: THREE.Material[][] = [];
    private _modelShadowGeometries: THREE.BufferGeometry[][] = [];
    /** Player travel at which the next spawn is attempted. */
    private _nextSpawnAt = 0;
    /** Drives indicator blinking; shared so every signal blinks in phase. */
    private _blinkClock = 0;
    /** Scratch objects shared by the sequential traffic placement pass. */
    private _rideEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    private _rideQuaternion = new THREE.Quaternion();
    private _ridePoint = new THREE.Vector3();

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
        if (t.pool.length !== t.maxAlive) {
            throw new Error('traffic.pool must contain exactly traffic.maxAlive model names.');
        }
        const slotTypes = t.pool.map((name) => {
            const index = t.types.findIndex((type) => type.name === name);
            if (index < 0) throw new Error(`Unknown traffic pool model "${name}".`);
            return index;
        });

        for (let i = 0; i < t.maxAlive; i++) {
            const node = new Node();
            const group = node.addComponent(Group3D);
            scene.addChild(node);

            const body = new THREE.Mesh(bodyGeometry, new THREE.MeshBasicMaterial({ visible: false }));
            body.visible = false;

            // Unlit, so it reads as a lamp rather than a painted panel — and it
            // stays visible on the shadowed side of a vehicle.
            const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
            indicator.visible = false;

            group.object3D.add(body, indicator);
            group.object3D.visible = false;

            this._pool.push({
                group, body, indicator, model: null, lodModel: null, fullDetail: true,
                spinWheels: () => {}, spinLodWheels: () => {},
                modelType: slotTypes[i % slotTypes.length], active: false, type: 0,
                laneF: 0, targetLane: 0, worldZ: 0,
                desiredSpeed: 0, speed: 0,
                manoeuvre: Manoeuvre.CRUISING, signalTimer: 0, signalDir: 0,
                laneYaw: 0, counted: false,
                halfWidth: 0, halfLength: 0, height: 0,
            });
        }
        this.reset();
    }

    /** Hides the pre-seeded pool while the car-selection screen is open. */
    deactivate(): void {
        for (const v of this._pool) {
            v.active = false;
            v.group.object3D.visible = false;
            v.indicator.visible = false;
        }
    }

    /**
     * Adds one configured FBX clone to each pool slot. The slot's model type is
     * fixed up front, so traffic keeps the no-allocation spawn/recycle contract.
     */
    attachModels(models: VehicleModels): void {
        this._materials = [];
        this._materialsByType = cfg.traffic.types.map(() => [] as THREE.Material[]);
        this._modelShadowGeometries = cfg.traffic.types.map(() => [] as THREE.BufferGeometry[]);
        for (const v of this._pool) {
            if (v.model) v.group.object3D.remove(v.model);
            if (v.lodModel) v.group.object3D.remove(v.lodModel);
            const spec = cfg.traffic.types[v.modelType];
            const visual = models.create(spec.model);
            // VehicleModels rests each visual on y=0. Traffic uses the same
            // wheel/ground pivot as PlayerCar, so matching models have matching
            // placement and scale in both roles.
            if (this._modelShadowGeometries[v.modelType].length === 0) {
                this._modelShadowGeometries[v.modelType] = visual.shadowGeometries;
            }
            v.model = visual.root;
            v.spinWheels = visual.spinWheels;
            v.group.object3D.add(v.model);
            const lodVisual = models.create(spec.model, 'distant');
            // The compact LOD shares the full model's ground-pivot origin.
            v.lodModel = lodVisual.root;
            v.lodModel.visible = false;
            v.spinLodWheels = lodVisual.spinWheels;
            v.group.object3D.add(v.lodModel);
            this._materials.push(...visual.materials, ...lodVisual.materials);
            this._materialsByType[v.modelType].push(...visual.materials, ...lodVisual.materials);
        }
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
    update(dt: number, travelled: number, speedT: number, playerX: number): void {
        this._blinkClock += dt;

        // QA mode: retain the seeded traffic at its absolute world positions so
        // the player can approach it from either side and inspect shadows.
        // The objects still get placed in render space as the player moves; only
        // their driving AI, wheel spin, despawn and replacement spawning pause.
        if (cfg.traffic.frozen) {
            for (const v of this._pool) {
                if (!v.active) continue;
                this._place(v, travelled);
                this._updateLod(v, playerX);
            }
            return;
        }

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
            this._updateLod(v, playerX);
            v.spinWheels(v.worldZ);
            v.spinLodWheels(v.worldZ);
        }

        if (travelled >= this._nextSpawnAt) {
            this._placeAt(travelled + cfg.traffic.spawnAhead, travelled, playerX);
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
            if (v.signalTimer <= 0) {
                // Re-check after signalling: speeds and nearby traffic may have
                // changed since this lane was first selected. The reservation
                // keeps new cars out, while this catches older conflicting
                // manoeuvres and cars that closed the gap during the signal.
                if (this._laneIsClear(v, v.targetLane, false)) {
                    v.manoeuvre = Manoeuvre.CHANGING;
                } else {
                    v.targetLane = Math.round(v.laneF);
                    v.manoeuvre = Manoeuvre.CRUISING;
                    v.signalDir = 0;
                }
            }
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

        // Point the body along the path it is actually taking. `laneF` moves at
        // lanes/second, so convert that to lateral metres/second and compare it
        // with forward speed. Local forward is -Z: moving toward +X therefore
        // needs a negative yaw, matching the player's steering convention.
        const laneWidth = (cfg.road.halfWidth * 2) / cfg.traffic.laneCount;
        const lateralSpeed = v.manoeuvre === Manoeuvre.CHANGING
            ? v.signalDir * o.laneChangeSpeed * laneWidth
            : 0;
        const pathYaw = -Math.atan2(lateralSpeed, Math.max(v.speed, 0.01));
        const targetLaneYaw = THREE.MathUtils.clamp(
            pathYaw, -o.laneChangeMaxYaw, o.laneChangeMaxYaw,
        );
        const yawK = 1 - Math.exp(-o.laneChangeYawResponse * dt);
        v.laneYaw += (targetLaneYaw - v.laneYaw) * yawK;

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
            if (!this._laneIsClear(v, candidate, true)) continue;
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

    /** Whether a vehicle physically occupies or has reserved `lane`. */
    private _usesLane(v: TrafficVehicle, lane: number): boolean {
        return Math.abs(v.laneF - lane) <= 0.6
            || (v.manoeuvre !== Manoeuvre.CRUISING && v.targetLane === lane);
    }

    /**
     * Whether `lane` stays clear for the whole manoeuvre, not only this frame.
     * Reservations prevent two cars from independently choosing the same gap.
     */
    private _laneIsClear(
        v: TrafficVehicle,
        lane: number,
        includeSignalTime: boolean,
    ): boolean {
        const o = cfg.traffic.overtake;
        const laneDistance = Math.abs(lane - v.laneF);
        const horizon = (includeSignalTime ? o.signalTime : 0)
            + laneDistance / o.laneChangeSpeed;

        for (const other of this._pool) {
            if (!other.active || other === v) continue;
            if (!this._usesLane(other, lane)) continue;

            const gapNow = other.worldZ - v.worldZ;
            const gapAtCompletion = gapNow + (other.speed - v.speed) * horizon;
            const nearestBehind = Math.min(gapNow, gapAtCompletion);
            const nearestAhead = Math.max(gapNow, gapAtCompletion);

            // The relative gap moves linearly over this short horizon. If its
            // swept interval intersects the forbidden zone, the paths conflict.
            if (nearestAhead > -o.minGapBehind && nearestBehind < o.minGapAhead) {
                return false;
            }
        }
        return true;
    }

    /**
     * Push a decal for every live vehicle. Positions match `_place` exactly —
     * same x, same render z, and the ground they sit ON rather than their own
     * centre, so the shadow lands on the asphalt and not inside the box.
     */
    /**
     * One silhouette per vehicle TYPE, baked from that type's own box. Sharing a
     * single box and scaling it would be wrong: a box's silhouette from an angle
     * is a hexagon whose shape depends on its aspect ratio, so a bus and a car
     * do not project to scaled copies of each other.
     */
    /** Every vehicle material, so traffic can RECEIVE the player's shadow. */
    get receiverMaterials(): THREE.Material[] { return this._materials; }

    /**
     * Traffic shares one baked silhouette per configured type. Grouping
     * receivers the same way lets a Sedan ignore its own Sedan silhouette,
     * eliminating self-shadowing without adding one atlas cell per live car.
     */
    get receiverMaterialsByType(): readonly (readonly THREE.Material[])[] {
        return this._materialsByType;
    }

    projectedHandle(type: number): number { return this._projectedHandles[type] ?? -1; }

    /**
     * Registers one caster per vehicle TYPE.
     *
     * Per type and not one scaled box: a box's silhouette is a hexagon whose
     * shape depends on its aspect ratio, so a bus is not a stretched car. Four
     * types, four cells in the atlas.
     *
     * The geometry is raised from the wheel/ground pivot, matching `_place`.
     */
    registerProjected(shadows: ProjectedShadows): void {
        this._projectedHandles = cfg.traffic.types.map(type =>
            shadows.register(new THREE.BoxGeometry(type.width, type.height, type.length)
                .translate(0, type.height / 2, 0)));
    }

    /** Replaces the registered box proxies with one normalized FBX capture per type. */
    refreshProjectedGeometry(shadows: ProjectedShadows): void {
        for (let type = 0; type < this._projectedHandles.length; type++) {
            const geometries = this._modelShadowGeometries[type];
            if (geometries.length > 0) shadows.setCasterGeometry(this._projectedHandles[type], geometries);
        }
    }

    /**
     * Submits every live vehicle. Priority is the squared distance from the
     * camera's end of the world, so when there are more vehicles than slots the
     * nearest ones win — which is the only place a shadow is legible anyway.
     */
    addProjected(shadows: ProjectedShadows): void {
        for (const v of this._pool) {
            if (!v.active) continue;
            const obj = v.group.object3D;
            shadows.add(
                this._projectedHandles[v.type],
                obj.position.x, obj.position.y, obj.position.z,
                obj.rotation.y,
                obj.position.x * obj.position.x + obj.position.z * obj.position.z,
            );
        }
    }

    private _projectedHandles: number[] = [];

    /** Drivable height beneath a yawed point on a vehicle's local footprint. */
    private _heightAtLocal(
        localX: number,
        localZ: number,
        centreX: number,
        centreWorldZ: number,
        yaw: number,
    ): number {
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        const x = centreX + localX * cos + localZ * sin;
        // Render Z is mirrored relative to absolute world Z.
        const z = centreWorldZ + localX * sin - localZ * cos;
        return surfaceHeightAt(x, z);
    }

    /** Lowest ground-pivot height that keeps the whole tilted body above the road. */
    private _requiredCentreHeight(
        v: TrafficVehicle,
        centreX: number,
        pitch: number,
        yaw: number,
        roll: number,
    ): number {
        this._rideEuler.set(pitch, yaw, roll, 'YXZ');
        this._rideQuaternion.setFromEuler(this._rideEuler);

        let required = -Infinity;
        // Corners, edge centres and the chassis centre make long vehicles
        // behave correctly over both crests and dips without frame allocations.
        for (let xi = -1; xi <= 1; xi++) {
            for (let zi = -1; zi <= 1; zi++) {
                const localX = xi * v.halfWidth;
                const localZ = zi * v.halfLength;
                this._ridePoint
                    .set(localX, 0, localZ)
                    .applyQuaternion(this._rideQuaternion);
                const need = this._heightAtLocal(
                    localX, localZ, centreX, v.worldZ, yaw,
                ) - this._ridePoint.y;
                if (need > required) required = need;
            }
        }
        return required;
    }

    private _place(v: TrafficVehicle, travelled: number): void {
        const x = this.worldXOf(v);
        // Road yaw follows the curve; lane yaw turns the body into its lateral
        // path during an overtake and smoothly returns it to the lane afterward.
        const yaw = roadHeadingAt(v.worldZ) + v.laneYaw;

        // Sample the four yawed footprint corners. A centre sample gives the
        // wrong height and no roll, which is especially visible on descents and
        // while a long vehicle crosses a crest.
        const frontLeft = this._heightAtLocal(
            -v.halfWidth, -v.halfLength, x, v.worldZ, yaw,
        );
        const frontRight = this._heightAtLocal(
            v.halfWidth, -v.halfLength, x, v.worldZ, yaw,
        );
        const rearLeft = this._heightAtLocal(
            -v.halfWidth, v.halfLength, x, v.worldZ, yaw,
        );
        const rearRight = this._heightAtLocal(
            v.halfWidth, v.halfLength, x, v.worldZ, yaw,
        );
        const front = (frontLeft + frontRight) * 0.5;
        const rear = (rearLeft + rearRight) * 0.5;
        const left = (frontLeft + rearLeft) * 0.5;
        const right = (frontRight + rearRight) * 0.5;
        const pitch = Math.atan2(front - rear, v.halfLength * 2);
        const roll = Math.atan2(right - left, v.halfWidth * 2);

        const obj = v.group.object3D;
        obj.position.set(
            x,
            this._requiredCentreHeight(v, x, pitch, yaw, roll),
            travelled - v.worldZ,
        );
        // YXZ keeps pitch and road roll local to the yawed vehicle body.
        obj.rotation.set(pitch, yaw, roll, 'YXZ');

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
                v.height * 0.6,
                v.halfLength + s * 0.3,
            );
            const phase = Math.floor(this._blinkClock * cfg.traffic.overtake.blinkHz * 2) % 2;
            v.indicator.visible = phase === 0;
        }
    }

    private _placeAt(spawnZ: number, travelled: number, playerX = 0): boolean {
        const t = cfg.traffic;
        const slot = this._pool.find(v => !v.active);
        if (!slot) return false;                 // pool full — density is capped

        const free: number[] = [];
        let clearNearby = 0;
        for (let lane = 0; lane < t.laneCount; lane++) {
            const occupiedAtSpawn = this._pool.some(v =>
                v.active && this._usesLane(v, lane) && Math.abs(v.worldZ - spawnZ) < t.minLaneGap);
            const occupiedNearby = this._pool.some(v =>
                v.active && this._usesLane(v, lane) && Math.abs(v.worldZ - spawnZ) < t.freeLaneCheckRange);
            if (!occupiedAtSpawn) free.push(lane);
            if (!occupiedNearby) clearNearby++;
        }
        if (free.length === 0) return false;
        // Spawning here would drop the clear-lane count below the guarantee.
        if (clearNearby - 1 < t.minFreeLanes) return false;

        const lane = free[Math.floor(Math.random() * free.length)];
        const type = slot.modelType;
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
        slot.laneYaw = 0;
        slot.halfWidth = spec.width / 2;
        slot.halfLength = spec.length / 2;
        slot.height = spec.height;

        // Indicator on the rear face, offset to whichever side is being signalled
        // — repositioned when a manoeuvre starts, so one mesh covers both sides.
        const s = t.overtake.indicatorSize;
        slot.indicator.scale.set(s, s, s * 0.5);

        slot.group.object3D.visible = true;
        slot.indicator.visible = false;
        this._place(slot, travelled);
        this._updateLod(slot, playerX, true);
        slot.spinWheels(slot.worldZ);
        slot.spinLodWheels(slot.worldZ);
        return true;
    }

    /** Switches a vehicle between its detailed FBX and reduced same-car tier. */
    private _updateLod(v: TrafficVehicle, playerX: number, force = false): void {
        if (!v.model || !v.lodModel) return;
        const lod = cfg.traffic.lod;
        const obj = v.group.object3D;
        const dx = obj.position.x - playerX;
        const fullDetail = !lod.enabled
            || dx * dx + obj.position.z * obj.position.z < lod.fullDetailDistance * lod.fullDetailDistance;
        if (!force && v.fullDetail === fullDetail) return;
        v.fullDetail = fullDetail;
        v.model.visible = fullDetail;
        v.lodModel.visible = !fullDetail;
    }

}
