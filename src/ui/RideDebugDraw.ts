import * as THREE from 'three';
import { Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { surfaceHeightAt, surfaceNormalAt } from '../procedural/heightField';
import { roadCenterX, roadRibbonYAt } from '../world/roadPath';
import type { PlayerCar } from '../game/PlayerCar';

type RideColors = { [K in keyof typeof cfg.debug.rideNormals.colors]: THREE.Color };

/**
 * RideDebugDraw — live ground-truth lines and numbers for the two reported
 * symptoms: "the car looks like it's flying" and "it doesn't pitch with the
 * road surface".
 *
 * A single screenshot can't settle either claim: the float is a gap that comes
 * and goes with speed and road curvature, and a wrong-looking pitch can be
 * phase-lagged damping that only reads at speed. So this draws the DATA every
 * frame instead of trusting one captured moment:
 *
 *  - CYAN — `surfaceHeightAt`, the analytic surface the car actually rests
 *    on: a polyline along the car's own x, plus finite-difference normals at
 *    each sampled tyre contact, at the body centre, and every
 *    `profileSpacing` metres along the road behind and ahead.
 *  - ORANGE — the chord the streamed asphalt ribbon is REALLY drawn as
 *    (`RoadMesh` writes one vertex row every `bandLength / segmentsPerBand`
 *    metres and the GPU linearly interpolates). A tick joins the two at every
 *    station: green where they agree, red where the car rests on a height the
 *    renderer is not drawing — the "hovering over asphalt" suspect, measured.
 *  - PINK — the body's real forward and up axes, from its quaternion.
 *  - YELLOW — the plane the suspension fitted from its four samples, so
 *    "fitted wrong" and "lagging behind" stay distinguishable.
 *  - WHITE — the ground line between the axles the pitch target came from.
 *  - GREEN→RED verticals — the gap between the rendered tyre contact and the
 *    surface under it; MAGENTA where the body plane is below the surface.
 *
 * The three mono labels carry the same story numerically for when the lines
 * overlap or the symptom is transient: attitude targets vs actuals, the four
 * tyre gaps, surface-normal tilt vs body pitch, analytic-vs-ribbon error at
 * the car, and — in `s` — PlayerCar's own height samples minus an independent
 * recomputation through its quaternion. If both transforms agree, `s` sits at
 * zero; if it moves, the sampling math is the bug, not the suspension.
 */
export class RideDebugDraw {

    private static readonly MAX_SEGMENTS = 192;

    private readonly _geometry = new THREE.BufferGeometry();
    private readonly _positions: Float32Array;
    private readonly _colors: Float32Array;
    private readonly _positionAttr: THREE.BufferAttribute;
    private readonly _colorAttr: THREE.BufferAttribute;
    private readonly _line: THREE.LineSegments;
    private readonly _material: THREE.LineBasicMaterial;
    private readonly _labels: Label[] = [];
    private readonly _labelNodes: Node[] = [];
    private readonly _lastText = ['', '', ''];
    private _count = 0;

    /** Preallocated scratch — the per-frame path never allocates geometry. */
    private readonly _normal = new THREE.Vector3();
    private readonly _point = new THREE.Vector3();
    private readonly _yawOnly = new THREE.Quaternion();
    private readonly _fitted = new THREE.Quaternion();
    private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');
    private readonly _gapScratch = new THREE.Color();
    private readonly _palette: RideColors;
    /** Rendered body-plane gaps and independent sample re-checks, FL/FR/RL/RR. */
    private readonly _gapAt = new Float64Array(4);
    private readonly _sampleCheck = new Float64Array(4);
    /** Tyre contacts in FL/FR/RL/RR order, filled each frame from `_fillLocals`. */
    private readonly _locals: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];

    constructor(
        scene: Scene,
        private readonly _threeScene: THREE.Scene,
        private readonly _car: PlayerCar,
    ) {
        const c = cfg.debug.rideNormals;
        const vertexCount = RideDebugDraw.MAX_SEGMENTS * 2;
        this._positions = new Float32Array(vertexCount * 3);
        this._colors = new Float32Array(vertexCount * 3);
        this._positionAttr = new THREE.BufferAttribute(this._positions, 3);
        this._colorAttr = new THREE.BufferAttribute(this._colors, 3);
        this._geometry.setAttribute('position', this._positionAttr);
        this._geometry.setAttribute('color', this._colorAttr);
        this._geometry.setDrawRange(0, 0);
        this._material = new THREE.LineBasicMaterial({
            vertexColors: true,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.95,
        });
        this._line = new THREE.LineSegments(this._geometry, this._material);
        this._line.renderOrder = 2000;
        this._line.frustumCulled = false;
        this._threeScene.add(this._line);

        this._palette = {
            surface: new THREE.Color(c.colors.surface),
            ribbon: new THREE.Color(c.colors.ribbon),
            body: new THREE.Color(c.colors.body),
            fitted: new THREE.Color(c.colors.fitted),
            slope: new THREE.Color(c.colors.slope),
            gapGood: new THREE.Color(c.colors.gapGood),
            gapBad: new THREE.Color(c.colors.gapBad),
            sunk: new THREE.Color(c.colors.sunk),
        };

        for (let i = 0; i < 3; i++) {
            const node = new Node(cfg.design.width / 2, c.labelY + i * c.labelLineGap);
            const label = node.addComponent(Label);
            label.fontSize = c.labelFontSize;
            label.color = c.labelColor;
            label.fontFamily = 'monospace';
            label.dynamic = true;
            label.text = '';
            scene.addChild(node);
            this._labels.push(label);
            this._labelNodes.push(node);
        }
    }

    /** Appends one coloured segment, silently dropping past the fixed budget. */
    private _segment(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        color: THREE.Color,
    ): void {
        if (this._count >= RideDebugDraw.MAX_SEGMENTS) return;
        const i = this._count * 6;
        this._positions[i] = ax; this._positions[i + 1] = ay; this._positions[i + 2] = az;
        this._positions[i + 3] = bx; this._positions[i + 4] = by; this._positions[i + 5] = bz;
        this._colors[i] = color.r; this._colors[i + 1] = color.g; this._colors[i + 2] = color.b;
        this._colors[i + 3] = color.r; this._colors[i + 4] = color.g; this._colors[i + 5] = color.b;
        this._count++;
    }

    /**
     * Unit surface normal at a world point, in RENDER space — the shared
     * world-space gradient with z flipped for the render mirror.
     */
    private _surfaceNormal(worldX: number, worldZ: number, out: THREE.Vector3): void {
        surfaceNormalAt(worldX, worldZ, out, cfg.debug.rideNormals.sampleEpsilon);
        out.z = -out.z;
    }

    /** Normal as a stem from (x, y, z) plus a short horizontal tick at its tip. */
    private _drawNormal(x: number, y: number, z: number, n: THREE.Vector3, color: THREE.Color): void {
        const length = cfg.debug.rideNormals.normalLength;
        const tx = x + n.x * length;
        const ty = y + n.y * length;
        const tz = z + n.z * length;
        this._segment(x, y, z, tx, ty, tz, color);
        // n × up = (−n.z, 0, n.x): a horizontal perpendicular, so the tick
        // stays horizontal however the normal tilts.
        let px = -n.z;
        let pz = n.x;
        const len = Math.hypot(px, pz);
        if (len < 1e-4) { px = 1; pz = 0; } else { px /= len; pz /= len; }
        const h = length * 0.22;
        this._segment(tx - px * h, ty, tz - pz * h, tx, ty, tz, color);
        this._segment(tx + px * h, ty, tz + pz * h, tx, ty, tz, color);
    }

    /** Horizontal cross marking an exact surface sample point. */
    private _drawCross(x: number, y: number, z: number): void {
        const s = cfg.debug.rideNormals.contactCross;
        const color = this._palette.surface;
        this._segment(x - s, y, z, x + s, y, z, color);
        this._segment(x, y, z - s, x, y, z + s, color);
    }

    /**
     * Vertical from the rendered body-plane contact down to the surface — the
     * literal float gap. Green inside `gapTolerance`, fading to `gapFull` red
     * above it, magenta when the body plane is under the surface.
     */
    private _drawGap(bodyY: number, groundY: number, x: number, z: number): void {
        const c = cfg.debug.rideNormals;
        const gap = bodyY - groundY;
        let color: THREE.Color;
        if (gap < 0) color = this._palette.sunk;
        else if (gap <= c.gapTolerance) color = this._palette.gapGood;
        else {
            const t = Math.min(1, (gap - c.gapTolerance) / Math.max(1e-5, c.gapFull - c.gapTolerance));
            color = this._gapScratch.lerpColors(this._palette.gapGood, this._palette.gapBad, t);
        }
        this._segment(x, bodyY, z, x, groundY, z, color);
    }

    /**
     * Fills `_locals` with [FL, FR, RL, RR] ground-plane contacts via
     * `PlayerCar.writeTyreLocals` — FBX tyre positions when the visual exposes
     * them, else the sampled footprint.
     */
    private _fillLocals(car: PlayerCar): void {
        car.writeTyreLocals(this._locals);
    }

    /** Rewrites every line and number for this frame. `travelled` is the car's world Z. */
    update(travelled: number): void {
        const c = cfg.debug.rideNormals;
        const car = this._car;
        const tel = car.rideDebug;
        const origin = car.position;
        const halfWidth = cfg.road.halfWidth;
        this._count = 0;

        // ── 1. Road profile along the car's x: analytic surface vs drawn ribbon.
        const lines = c.lines;
        let hasPrev = false, px = 0, py = 0, pz = 0;
        let hasRibbonPrev = false, rpx = 0, rpy = 0, rpz = 0;
        const stations = Math.max(1, Math.round((c.profileBehind + c.profileAhead) / c.profileSpacing));
        for (let i = lines.profile || lines.profileNormals ? 0 : stations + 1; i <= stations; i++) {
            const offset = -c.profileBehind + i * c.profileSpacing;
            const worldZ = travelled + offset;
            const renderZ = -offset;   // render z = travelled − worldZ
            const analyticY = surfaceHeightAt(origin.x, worldZ);
            if (lines.profile) {
                if (hasPrev) this._segment(px, py, pz, origin.x, analyticY, renderZ, this._palette.surface);
                px = origin.x; py = analyticY; pz = renderZ; hasPrev = true;

                if (Math.abs(origin.x - roadCenterX(worldZ)) > halfWidth) {
                    hasRibbonPrev = false;
                } else {
                    const ribbonY = roadRibbonYAt(worldZ);
                    if (hasRibbonPrev) this._segment(rpx, rpy, rpz, origin.x, ribbonY, renderZ, this._palette.ribbon);
                    rpx = origin.x; rpy = ribbonY; rpz = renderZ; hasRibbonPrev = true;
                    // Measured error: the surface the car rests on, minus the ribbon drawn.
                    const error = analyticY - ribbonY;
                    this._segment(origin.x, ribbonY, renderZ, origin.x, analyticY, renderZ,
                        Math.abs(error) <= c.gapTolerance ? this._palette.gapGood : this._palette.gapBad);
                }
            }

            if (lines.profileNormals) {
                this._surfaceNormal(origin.x, worldZ, this._normal);
                this._drawNormal(origin.x, analyticY, renderZ, this._normal, this._palette.surface);
            }
        }

        // ── 2. Four tyre contacts — gap vertical, cross and normal under each.
        this._yawOnly.setFromEuler(this._euler.set(0, tel.yaw, 0, 'YXZ'));
        this._fillLocals(car);
        for (let i = 0; i < 4; i++) {
            const lx = this._locals[i][0];
            const lz = this._locals[i][1];
            // Full attitude: where the rendered body plane's tyre contact sits.
            this._point.set(lx, 0, lz).applyQuaternion(car.bodyQuaternion).add(origin);
            const groundY = surfaceHeightAt(this._point.x, travelled - this._point.z);
            this._gapAt[i] = this._point.y - groundY;
            if (lines.contactDetails) {
                this._drawGap(this._point.y, groundY, this._point.x, this._point.z);
                this._drawCross(this._point.x, groundY, this._point.z);
            }
            if (lines.contactNormals) {
                this._surfaceNormal(this._point.x, travelled - this._point.z, this._normal);
                this._drawNormal(this._point.x, groundY, this._point.z, this._normal, this._palette.surface);
            }
        }

        // ── 3. Independent recomputation of PlayerCar's own samples, in its
        // yaw-only sampling frame. The `s` readout below is its height minus
        // this: zero means both transforms agree, non-zero pins the bug on
        // the sampling math rather than on the suspension.
        for (let i = 0; i < 4; i++) {
            const lx = (i & 1) === 0 ? -tel.wheelX : tel.wheelX;
            const lz = i < 2 ? -tel.axleZ : tel.axleZ;
            this._point.set(lx, 0, lz).applyQuaternion(this._yawOnly).add(origin);
            const sample = i === 0 ? tel.frontLeft : i === 1 ? tel.frontRight
                : i === 2 ? tel.rearLeft : tel.rearRight;
            this._sampleCheck[i] = sample - surfaceHeightAt(this._point.x, travelled - this._point.z);
        }

        // ── 4. Body centre: surface under it, its normal, the float gap, and
        // the real vs fitted axes that must line up with that normal.
        const centreWorldZ = travelled - origin.z;
        const centreY = surfaceHeightAt(origin.x, centreWorldZ);
        this._surfaceNormal(origin.x, centreWorldZ, this._normal);
        const normalTilt = Math.acos(Math.min(1, Math.max(-1, this._normal.y))) * (180 / Math.PI);
        if (lines.contactDetails) {
            this._drawCross(origin.x, centreY, origin.z);
            this._drawGap(origin.y, centreY, origin.x, origin.z);
        }
        if (lines.contactNormals) {
            this._drawNormal(origin.x, centreY, origin.z, this._normal, this._palette.surface);
        }

        if (lines.axes) {
            // Pink: the body's actual forward and up axes from its quaternion.
            this._point.set(0, 1.8, 0).applyQuaternion(car.bodyQuaternion).add(origin);
            this._segment(origin.x, origin.y, origin.z, this._point.x, this._point.y, this._point.z, this._palette.body);
            this._point.set(0, 0, -2.8).applyQuaternion(car.bodyQuaternion).add(origin);
            this._segment(origin.x, origin.y, origin.z, this._point.x, this._point.y, this._point.z, this._palette.body);

            // Yellow: the plane the suspension fitted — if this leaves the cyan
            // normal while pink trails it, the lag (not the fit) is the problem.
            this._fitted.setFromEuler(this._euler.set(tel.pitchTarget, tel.yaw, tel.rollTarget, 'YXZ'));
            this._point.set(0, 1.15, 0).applyQuaternion(this._fitted).add(origin);
            this._segment(origin.x, origin.y, origin.z, this._point.x, this._point.y, this._point.z, this._palette.fitted);
        }

        if (lines.slopeLine) {
            // White: the ground line between the axles the pitch target came from.
            this._point.set(0, 0, -tel.axleZ).applyQuaternion(this._yawOnly).add(origin);
            const frontGroundY = surfaceHeightAt(this._point.x, travelled - this._point.z);
            const frontX = this._point.x, frontZ2 = this._point.z;
            this._point.set(0, 0, tel.axleZ).applyQuaternion(this._yawOnly).add(origin);
            const rearGroundY = surfaceHeightAt(this._point.x, travelled - this._point.z);
            this._segment(frontX, frontGroundY, frontZ2, this._point.x, rearGroundY, this._point.z, this._palette.slope);
        }

        this._geometry.setDrawRange(0, this._count * 2);
        this._positionAttr.needsUpdate = true;
        this._colorAttr.needsUpdate = true;

        // ── 5. The readout. Built every frame, pushed to the labels only when
        // it changes, so a paused or settled frame costs nothing.
        const deg = 180 / Math.PI;
        const off = origin.x - roadCenterX(centreWorldZ);
        const onRoad = Math.abs(off) <= halfWidth;
        const ribCm = Math.round((centreY - roadRibbonYAt(centreWorldZ)) * 100);
        const lineA = `P ${sign(tel.pitchTarget * deg, 1)}/${sign(tel.pitch * deg, 1)}`
            + ` R ${sign(tel.rollTarget * deg, 1)}/${sign(tel.roll * deg, 1)}`
            + ` Y ${(tel.yaw * deg).toFixed(1)}`
            + ` y ${tel.y.toFixed(3)} f ${tel.floor.toFixed(3)} c ${sign(origin.y - centreY, 3)}`;
        const lineB = `g ${sign(this._gapAt[0], 3)}/${sign(this._gapAt[1], 3)}`
            + `/${sign(this._gapAt[2], 3)}/${sign(this._gapAt[3], 3)}`
            + ` nT ${normalTilt.toFixed(1)} rib ${onRoad ? `${sign(ribCm, 0)}cm` : 'n/a'}`
            + ` z ${centreWorldZ.toFixed(1)}`;
        let lineC = `s ${sign(this._sampleCheck[0], 3)}/${sign(this._sampleCheck[1], 3)}`
            + `/${sign(this._sampleCheck[2], 3)}/${sign(this._sampleCheck[3], 3)}`
            + ` off ${off.toFixed(2)} w ${car.wheelContacts.length === 4 ? 'fbx' : 'cfg'}`;
        if (car.wheelContacts.length === 4) {
            // Sample wheelbase/track vs the FBX's real ones — the lever arms
            // the pitch and roll targets are scaled by.
            let frontZ = 0, rearZ = 0, frontN = 0, rearN = 0, absX = 0;
            for (const p of car.wheelContacts) {
                if (p.z < 0) { frontZ += p.z; frontN++; } else { rearZ += p.z; rearN++; }
                absX += Math.abs(p.x);
            }
            if (frontN > 0 && rearN > 0) {
                const fbxWb = (rearZ / rearN) - (frontZ / frontN);
                lineC += ` wb ${(2 * tel.axleZ).toFixed(1)}/${fbxWb.toFixed(1)}`
                    + ` tr ${(2 * tel.wheelX).toFixed(1)}/${(absX * 0.5).toFixed(1)}`;
            }
        }
        this._setText(0, lineA);
        this._setText(1, lineB);
        this._setText(2, lineC);
    }

    dispose(): void {
        this._threeScene.remove(this._line);
        this._geometry.dispose();
        this._material.dispose();
        for (const node of this._labelNodes) node.active = false;
    }

    private _setText(index: number, text: string): void {
        if (text === this._lastText[index]) return;
        this._lastText[index] = text;
        this._labels[index].text = text;
    }
}

/** Signed fixed-decimal formatting for the readout (label path only). */
function sign(value: number, decimals: number): string {
    return `${value < 0 ? '-' : '+'}${Math.abs(value).toFixed(decimals)}`;
}
