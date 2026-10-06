/**
 * rideDataCheck — headless replay of the ride math over the real road, so the
 * "the car floats / doesn't pitch" questions get answered with NUMBERS before
 * (and independently of) a gameplay session.
 *
 * What runs for real: `surfaceHeightAt`, `roadRibbonYAt`, `roadCenterX`,
 * `gameConfig`. What is copied: PlayerCar's straight-line suspension update —
 * yaw = 0, so `_heightAtLocal` collapses to `surfaceHeightAt(cx + lx, cz - lz)`
 * and `_requiredHeight` to Rx(pitch) on the nine footprint points. Keep the
 * marked block in sync with PlayerCar.update if the suspension changes.
 *
 * Replay: constant speed, held dead-centre in the lane (ideal steering, so
 * curve-following noise can't contaminate the ride measurement), 60 Hz, over
 * 3000 m of the real road profile (≈7.6 slope wavelengths). Roll is exactly 0
 * on the camber-less road and yaw only shifts sample points laterally, so
 * pitch and height carry the whole story; steering is deliberately out of scope.
 *
 * Metrics per speed:
 *   pitchErrDeg  target vs damped pitch        ("doesn't pitch with the road")
 *   gapC         body vs ANALYTIC surface      (the suspension's own duty)
 *   visGap       body vs DRAWN ribbon          (what the eye actually sees)
 *   cornerGap    worst tyre-contact gap        (one end lifted while other plants)
 *
 * Plus a speed-independent ribbon scan: the analytic-vs-drawn error at every
 * metre of the road, and the `segmentsPerBand` that would shrink it under 2 cm.
 */
import { gameConfig as cfg } from '../src/config/gameConfig';
import { roadCenterX, roadRibbonYAt } from '../src/world/roadPath';
import { surfaceHeightAt } from '../src/procedural/heightField';

const DEG = 180 / Math.PI;
const DT = 1 / 60;
const DISTANCE = 3000;
const SPEEDS = [8, 25, 40, 54];

const spec = cfg.vehicles.models.find((m) => m.id === cfg.vehicles.playerDefault) ?? cfg.vehicles.models[0];
const halfWidth = spec.width / 2;
const halfLength = spec.length / 2;
const wheelX = halfWidth * 0.84;
const axleZ = halfLength * cfg.car.wheel.axleOffset;
const susp = cfg.car.suspension;

/** PlayerCar._heightAtLocal with yaw = 0. */
function heightAtLocal(lx: number, lz: number, cx: number, cz: number): number {
    return surfaceHeightAt(cx + lx, cz - lz);
}

/** PlayerCar._requiredHeight with yaw = roll = 0 (Rx(pitch) on the footprint). */
function requiredHeight(cx: number, cz: number, pitch: number): number {
    const sin = Math.sin(pitch);
    let required = -Infinity;
    for (let xi = -1; xi <= 1; xi++) {
        for (let zi = -1; zi <= 1; zi++) {
            const lx = xi * halfWidth;
            const lz = zi * halfLength;
            const need = heightAtLocal(lx, lz, cx, cz) - (-lz * sin);
            if (need > required) required = need;
        }
    }
    return required;
}

function stats(values: number[]): { min: number; mean: number; p95: number; max: number } {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    let sum = 0;
    for (const v of sorted) sum += v;
    return {
        min: sorted[0],
        mean: sum / n,
        p95: sorted[Math.floor(n * 0.95)],
        max: sorted[n - 1],
    };
}

function fmt(v: number, digits = 3): string {
    return v.toFixed(digits);
}

function replay(speed: number, tiltResponse = susp.tiltResponse, heightResponse = susp.heightResponse) {
    // Mirror PlayerCar.reset: the shipped car seeds its attitude from the road
    // at tz=0 instead of starting flat on the initial grade (measured at 21cm /
    // 3.8° startup hop before the fix), and solves y with that pitch.
    const c0 = roadCenterX(0);
    const iFront = (heightAtLocal(-wheelX, -axleZ, c0, 0) + heightAtLocal(wheelX, -axleZ, c0, 0)) * 0.5;
    const iRear = (heightAtLocal(-wheelX, axleZ, c0, 0) + heightAtLocal(wheelX, axleZ, c0, 0)) * 0.5;
    let pitch = Math.atan2(iFront - iRear, axleZ * 2);
    let y = requiredHeight(c0, 0, pitch);
    let tz = 0;
    const pitchErrDeg: number[] = [];
    const gapC: number[] = [];
    const visGap: number[] = [];
    const cornerGap: number[] = [];
    /** Startup transient (first 100 m) tracked separately from steady state. */
    const startup = { vis: -Infinity, pitchErr: 0, corner: -Infinity };
    let worstVis = { v: -Infinity, tz: 0 };
    let worstCorner = { v: -Infinity, tz: 0 };
    let worstPitch = { v: 0, tz: 0 };
    const WARMUP = 100;

    while (tz < DISTANCE) {
        tz += speed * DT;
        const cx = roadCenterX(tz);
        const cz = tz;

        // ---- PlayerCar.update, straight-line copy (yaw = 0) ----
        const front = (heightAtLocal(-wheelX, -axleZ, cx, cz) + heightAtLocal(wheelX, -axleZ, cx, cz)) * 0.5;
        const rear = (heightAtLocal(-wheelX, axleZ, cx, cz) + heightAtLocal(wheelX, axleZ, cx, cz)) * 0.5;
        const targetPitch = Math.atan2(front - rear, axleZ * 2);
        pitch += (targetPitch - pitch) * (1 - Math.exp(-tiltResponse * DT));
        const floor = requiredHeight(cx, cz, pitch);
        y += (floor - y) * (1 - Math.exp(-heightResponse * DT));
        if (y < floor) y = floor;
        if (y > floor + susp.maxGroundGap) y = floor + susp.maxGroundGap;
        // ---- end copy ----

        const groundC = surfaceHeightAt(cx, cz);
        const vis = y - roadRibbonYAt(cz);
        const sin = Math.sin(pitch);
        let worst = -Infinity;
        for (const lz of [-axleZ, axleZ]) {
            for (const lx of [-wheelX, wheelX]) {
                const gap = (y - lz * sin) - heightAtLocal(lx, lz, cx, cz);
                if (gap > worst) worst = gap;
            }
        }
        const pitchErr = (targetPitch - pitch) * DEG;

        if (tz < WARMUP) {
            if (vis > startup.vis) startup.vis = vis;
            if (Math.abs(pitchErr) > Math.abs(startup.pitchErr)) startup.pitchErr = pitchErr;
            if (worst > startup.corner) startup.corner = worst;
            continue;
        }
        pitchErrDeg.push(pitchErr);
        gapC.push(y - groundC);
        visGap.push(vis);
        cornerGap.push(worst);
        if (vis > worstVis.v) worstVis = { v: vis, tz };
        if (worst > worstCorner.v) worstCorner = { v: worst, tz };
        if (Math.abs(pitchErr) > Math.abs(worstPitch.v)) worstPitch = { v: pitchErr, tz };
    }

    return {
        pitchErrDeg, gapC, visGap, cornerGap,
        worstVis, worstCorner, worstPitch, startup, speed,
        tiltResponse, heightResponse,
    };
}

// ── Ribbon scan: analytic vs drawn, every metre, speed-independent ──────────
let ribMax = { v: 0, tz: 0 };
let ribMin = { v: 0, tz: 0 };
const ribAbs: number[] = [];
for (let z = 0; z < DISTANCE; z += 1) {
    const err = surfaceHeightAt(roadCenterX(z), z) - roadRibbonYAt(z);
    ribAbs.push(Math.abs(err));
    if (err > ribMax.v) ribMax = { v: err, tz: z };
    if (err < ribMin.v) ribMin = { v: err, tz: z };
}
const ribSorted = [...ribAbs].sort((a, b) => a - b);
const ribP95 = ribSorted[Math.floor(ribSorted.length * 0.95)];
// Chord sag scales with row spacing²: Δ₂ = Δ₁·√(err₂/err₁), segments = bandLength / Δ.
const row = cfg.roadSurface.bandLength / cfg.roadSurface.segmentsPerBand;
const neededRow = row * Math.sqrt(0.02 / ribP95);
const neededSegments = Math.ceil(cfg.roadSurface.bandLength / neededRow);

console.log('================ rideDataCheck — real road, real surface, real suspension ================');
console.log(
    `vehicle ${spec.id}  footprint ${fmt(spec.width, 2)} x ${fmt(spec.length, 2)} m  `
    + `axleZ ${fmt(axleZ, 2)}  wheelX ${fmt(wheelX, 2)}  `
    + `tiltResponse ${susp.tiltResponse}  heightResponse ${susp.heightResponse}  maxGap ${susp.maxGroundGap} m`,
);
console.log(
    `road: slope ±${cfg.road.slopeAmplitude} m @ ${cfg.road.slopeFrequency} Hz  `
    + `(wavelength ${fmt((2 * Math.PI) / cfg.road.slopeFrequency, 0)} m, `
    + `max grade ~${fmt(cfg.road.slopeAmplitude * cfg.road.slopeFrequency * 1.315 * 100, 1)}%)`,
);

console.log('\n-- ribbon scan (analytic surface − drawn chord), every metre over 3000 m --');
console.log(
    `  err  min ${fmt(ribMin.v * 100, 1)} cm @ z=${fmt(ribMin.tz, 0)}   `
    + `max +${fmt(ribMax.v * 100, 1)} cm @ z=${fmt(ribMax.tz, 0)}   `
    + `p95 |err| ${fmt(ribP95 * 100, 1)} cm`,
);
console.log(
    `  → at segmentsPerBand ${cfg.roadSurface.segmentsPerBand} (row ${fmt(row, 1)} m): `
    + `${neededSegments} segments/row would hold p95 error under 2 cm (row ≈ ${fmt(neededRow, 2)} m)`,
);

console.log('\n-- suspension replay (60 Hz, lane-centred, 3000 m; stats steady-state, z ≥ 100 m) --');
console.log('  speed | pitchErrDeg            | gapC (analytic)     | visGap (drawn ribbon)     | cornerGap');
console.log('  m/s   |  mean   p95    max     |  mean   p95    max   |  mean   p95    max   min  |  max @z');
for (const speed of SPEEDS) {
    const r = replay(speed);
    const p = stats(r.pitchErrDeg);
    const g = stats(r.gapC);
    const v = stats(r.visGap);
    const c = stats(r.cornerGap);
    console.log(
        `  ${String(speed).padStart(5)} | ${fmt(p.mean, 2).padStart(6)} ${fmt(p.p95, 2).padStart(6)} ${fmt(p.max, 2).padStart(6)} `
        + ` | ${fmt(g.mean, 3).padStart(6)} ${fmt(g.p95, 3).padStart(6)} ${fmt(g.max, 3).padStart(6)}`
        + ` | ${fmt(v.mean, 2).padStart(6)} ${fmt(v.p95, 2).padStart(6)} ${fmt(v.max, 2).padStart(6)} ${fmt(v.min, 2).padStart(6)}`
        + ` | ${fmt(c.max, 2)} @${fmt(r.worstCorner.tz, 0)}`,
    );
    console.log(
        `        | steady worst |err| ${fmt(Math.abs(r.worstPitch.v), 2)} deg @ z=${fmt(r.worstPitch.tz, 0)}`
        + `   vis worst ${fmt(r.worstVis.v * 100, 1)} cm @ z=${fmt(r.worstVis.tz, 0)}`
        + `   STARTUP(vis ${fmt(r.startup.vis * 100, 1)} cm, pitch ${fmt(r.startup.pitchErr, 2)} deg, corner ${fmt(r.startup.corner, 2)} m)`,
    );
}

console.log('\n-- sensitivity at 54 m/s (steady-state p95 / steady worst) --');
const base = replay(54);
console.log(
    `  tiltResponse ${base.tiltResponse} (current): pitchErr p95 ${fmt(stats(base.pitchErrDeg).p95, 2)} deg`
    + ` / max ${fmt(stats(base.pitchErrDeg).max, 2)}  visGap p95 ${fmt(stats(base.visGap).p95 * 100, 1)} cm`,
);
for (const tilt of [30, 60]) {
    const r = replay(54, tilt);
    console.log(
        `  tiltResponse ${tilt}: pitchErr p95 ${fmt(stats(r.pitchErrDeg).p95, 2)} deg`
        + ` / max ${fmt(stats(r.pitchErrDeg).max, 2)}  visGap p95 ${fmt(stats(r.visGap).p95 * 100, 1)} cm`,
    );
}
for (const height of [40, 80]) {
    const r = replay(54, susp.tiltResponse, height);
    console.log(
        `  heightResponse ${height}: gapC p95 ${fmt(stats(r.gapC).p95 * 100, 1)} cm`
        + `  visGap p95 ${fmt(stats(r.visGap).p95 * 100, 1)} cm`,
    );
}
console.log('\n(units: degrees for pitch, metres for gaps; visGap > 0 = body ABOVE the drawn road = "flying")');
