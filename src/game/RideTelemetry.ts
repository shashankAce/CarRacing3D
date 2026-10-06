import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { roadCenterX, roadRibbonYAt } from '../world/roadPath';
import { surfaceHeightAt, surfaceNormalAt } from '../procedural/heightField';
import type { PlayerCar } from './PlayerCar';

/**
 * RideTelemetry — per-frame ride data recorder for the two reported symptoms
 * ("the car looks like it's flying", "it doesn't pitch with the road").
 *
 * The debug overlay draws lines and a live readout, but a screen full of lines
 * is exactly what's hard to judge mid-drive. This records every running frame
 * into preallocated column arrays, flags episodes (float / sink / pitch lag)
 * as they happen, and at run end:
 *
 *   1. prints an aggregate summary to the console — min / mean / p95 / max per
 *      metric plus the worst episodes — so a pasted console block is enough to
 *      judge a run, and
 *   2. downloads `ride-telemetry-<time>.ndjson`: meta line, one JSON object
 *      per sample, then the summary and episodes. Drop the file into the
 *      workspace and it can be analysed offline against the exact frames.
 *
 * `window.__rideTelemetry.dump()` re-downloads the current buffer at any time;
 * `.summary()` returns the last run's aggregates without touching the file.
 *
 * Every value comes from `PlayerCar.rideDebug` plus independent recomputation
 * through the same pure functions the game uses (`surfaceHeightAt`,
 * `roadRibbonYAt`) — the log measures the world, it doesn't trust a screenshot.
 */
type Episode = {
    kind: 'float' | 'sink' | 'lag';
    t0: number;
    t1: number;
    vMax: number;
    tAtMax: number;
    tzAtMax: number;
};

type Stats = { min: number; mean: number; p95: number; max: number };

/** One Float32Array per metric; the NDJSON row keys are these names.
 *  `vis` is body-origin vs drawn ribbon; `visW` adds `wheelBottomOffset`, i.e.
 *  the gap under the RENDERED tyre bottoms — the one the eye actually judges. */
const COLUMNS = [
    't', 'tz', 'v', 'vt', 'axis', 'off', 'yaw',
    'pitchT', 'pitch', 'rollT', 'roll', 'y', 'floor',
    'gapC', 'rib', 'vis', 'visW', 'tilt',
    'gFL', 'gFR', 'gRL', 'gRR', 'sMax',
] as const;
type ColumnKey = typeof COLUMNS[number];

/** Metrics the console summary and run summary report. */
const SUMMARY_KEYS: ColumnKey[] = [
    'vis', 'visW', 'gapC', 'rib', 'gFL', 'gFR', 'gRL', 'gRR', 'tilt', 'sMax', 'v',
];

export class RideTelemetry {

    private readonly _car: PlayerCar;
    private readonly _data: Float32Array[];
    private readonly _episodes: Episode[] = [];
    private readonly _locals: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
    private readonly _point = new THREE.Vector3();
    private readonly _normal = new THREE.Vector3();
    private _count = 0;
    private _t = 0;
    /** Travelled of the most recent sample — stamped into episodes. */
    private _lastTz = 0;
    /** Scratch for the four tyre-contact gaps of the current sample. */
    private readonly _gaps = new Float64Array(4);
    private _startedAt = '';
    private _truncated = false;
    private _active: { float: Episode | null; sink: Episode | null; lag: Episode | null } =
        { float: null, sink: null, lag: null };
    private _lastSummary: Record<string, unknown> | null = null;

    constructor(car: PlayerCar) {
        this._car = car;
        const max = cfg.debug.rideTelemetry.maxSamples;
        this._data = COLUMNS.map(() => new Float32Array(max));
        (globalThis as Record<string, unknown>).__rideTelemetry = {
            dump: () => this._export('manual'),
            summary: () => this._lastSummary,
            samples: () => this._count,
        };
    }

    /** Clears the buffer at the start of a run (`GameScene._restart`). */
    beginRun(): void {
        this._count = 0;
        this._t = 0;
        this._episodes.length = 0;
        this._truncated = false;
        this._startedAt = new Date().toISOString();
        this._active = { float: null, sink: null, lag: null };
    }

    /**
     * Records one running frame. Called right after `PlayerCar.update`, so the
     * row reflects exactly what the car did this frame.
     */
    sample(dt: number, speed: number, speedT: number, axis: number, travelled: number): void {
        const c = cfg.debug.rideTelemetry;
        if (this._count >= c.maxSamples) { this._truncated = true; return; }
        this._t += dt;
        this._lastTz = travelled;

        const car = this._car;
        const tel = car.rideDebug;
        const obj = car.position;
        const worldZ = travelled - obj.z;
        const off = obj.x - roadCenterX(worldZ);
        const groundY = surfaceHeightAt(obj.x, worldZ);
        const onRoad = Math.abs(off) <= cfg.road.halfWidth;
        const ribbonY = onRoad ? roadRibbonYAt(worldZ) : groundY;
        const gapC = obj.y - groundY;
        // What the eye sees: body against the ribbon actually drawn — the
        // "looks like it's flying" metric. Off-road there is no ribbon, so the
        // analytic surface is the visible one by definition.
        const vis = obj.y - ribbonY;

        surfaceNormalAt(obj.x, worldZ, this._normal, cfg.debug.rideNormals.sampleEpsilon);
        const tilt = Math.acos(Math.min(1, Math.max(-1, this._normal.y))) * (180 / Math.PI);

        // Rendered tyre-contact gaps under the full attitude quaternion.
        car.writeTyreLocals(this._locals);
        for (let k = 0; k < 4; k++) {
            this._point.set(this._locals[k][0], 0, this._locals[k][1])
                .applyQuaternion(car.bodyQuaternion).add(obj);
            this._gaps[k] = this._point.y - surfaceHeightAt(this._point.x, travelled - this._point.z);
        }

        // Transform cross-check: PlayerCar's own height samples minus the same
        // points recomputed through a yaw-only rotation of its rendered
        // position. Non-zero means the sampling transforms disagree — the bug
        // would be in the math, not the suspension.
        const sin = Math.sin(tel.yaw);
        const cos = Math.cos(tel.yaw);
        let sMax = 0;
        for (let k = 0; k < 4; k++) {
            const lx = (k & 1) === 0 ? -tel.wheelX : tel.wheelX;
            const lz = k < 2 ? -tel.axleZ : tel.axleZ;
            const rx = lx * cos + lz * sin;
            const rz = -lx * sin + lz * cos;
            const check = surfaceHeightAt(obj.x + rx, travelled - obj.z - rz);
            const sample = k === 0 ? tel.frontLeft : k === 1 ? tel.frontRight
                : k === 2 ? tel.rearLeft : tel.rearRight;
            const diff = Math.abs(sample - check);
            if (diff > sMax) sMax = diff;
        }

        const [dT, dTz, dV, dVt, dAxis, dOff, dYaw,
            dPitchT, dPitch, dRollT, dRoll, dY, dFloor,
            dGapC, dRib, dVis, dVisW, dTilt, dGFL, dGFR, dGRL, dGRR, dSMax] = this._data;
        const i = this._count;
        dT[i] = this._t; dTz[i] = travelled; dV[i] = speed; dVt[i] = speedT;
        dAxis[i] = axis; dOff[i] = off; dYaw[i] = tel.yaw;
        dPitchT[i] = tel.pitchTarget; dPitch[i] = tel.pitch;
        dRollT[i] = tel.rollTarget; dRoll[i] = tel.roll;
        dY[i] = obj.y; dFloor[i] = tel.floor;
        dGapC[i] = gapC; dRib[i] = groundY - ribbonY; dVis[i] = vis;
        dVisW[i] = vis + car.wheelBottomOffset;
        dTilt[i] = tilt;
        dGFL[i] = this._gaps[0]; dGFR[i] = this._gaps[1];
        dGRL[i] = this._gaps[2]; dGRR[i] = this._gaps[3];
        dSMax[i] = sMax;
        this._count = i + 1;

        // Episode detection. Severity is always "bigger = worse" so the same
        // tracker works for float, sink and lag alike.
        const pitchErr = Math.abs(tel.pitchTarget - tel.pitch);
        this._track('float', vis > c.floatThreshold, vis);
        this._track('sink', vis < -c.sinkThreshold, -vis);
        this._track('lag', pitchErr > c.pitchLagThreshold, pitchErr);
    }

    /** Opens, extends or closes the per-kind episode for this frame. */
    private _track(kind: Episode['kind'], active: boolean, severity: number): void {
        if (!active) {
            this._active[kind] = null;
            return;
        }
        const open = this._active[kind];
        if (open) {
            open.t1 = this._t;
            if (severity > open.vMax) {
                open.vMax = severity;
                open.tAtMax = this._t;
                open.tzAtMax = this._lastTz;
            }
            return;
        }
        if (this._episodes.length >= 5000) return;
        const episode: Episode = {
            kind, t0: this._t, t1: this._t, vMax: severity,
            tAtMax: this._t, tzAtMax: this._lastTz,
        };
        this._active[kind] = episode;
        this._episodes.push(episode);
    }

    /** Closes the run: console summary first, then the NDJSON download. */
    endRun(title: string): void {
        this._lastSummary = this._summarize(title);
        this._printSummary(this._lastSummary);
        if (cfg.debug.rideTelemetry.downloadOnRunEnd) this._export(title);
    }

    /**
     * Called from `onUnload` — summary only. Browser downloads are blocked
     * during unload, so a file written here would never land anywhere.
     */
    dispose(): void {
        if (this._count === 0) return;
        this._lastSummary = this._summarize('unload');
        this._printSummary(this._lastSummary);
    }

    private _summarize(title: string): Record<string, unknown> {
        const n = this._count;
        const stats: Record<string, Stats> = {};
        for (const key of SUMMARY_KEYS) stats[key] = this._stats(this._data[COLUMNS.indexOf(key)], n);
        // Derived from the stored columns, so the log itself stays raw.
        stats.pitchErrDeg = this._stats(this._derived(7, 8, 180 / Math.PI), n);
        stats.rollErrDeg = this._stats(this._derived(9, 10, 180 / Math.PI), n);
        const episodeCounts = { float: 0, sink: 0, lag: 0 };
        for (const episode of this._episodes) episodeCounts[episode.kind]++;
        const worstEpisodes = [...this._episodes]
            .sort((a, b) => b.vMax - a.vMax)
            .slice(0, 5);
        return {
            title,
            samples: n,
            seconds: Math.round(this._t * 100) / 100,
            truncated: this._truncated,
            startedAt: this._startedAt,
            endedAt: new Date().toISOString(),
            /** Baked-in visual float: rendered tyre bottoms above the origin plane. */
            wheelBottomOffset: this._car.wheelBottomOffset,
            stats,
            episodeCounts,
            worstEpisodes,
        };
    }

    /** (columnA − columnB) × scale, e.g. pitch target minus actual in degrees. */
    private _derived(aIndex: number, bIndex: number, scale: number): Float32Array {
        const n = this._count;
        const out = new Float32Array(n);
        const a = this._data[aIndex];
        const b = this._data[bIndex];
        for (let i = 0; i < n; i++) out[i] = (a[i] - b[i]) * scale;
        return out;
    }

    private _stats(values: Float32Array, n: number): Stats {
        if (n === 0) return { min: 0, mean: 0, p95: 0, max: 0 };
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const v = values[i];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
        }
        // One sort of a copy at run end — never on the frame path.
        const sorted = values.slice(0, n).sort();
        const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
        const round = (v: number) => Math.round(v * 1000) / 1000;
        return { min: round(min), mean: round(sum / n), p95: round(p95), max: round(max) };
    }

    private _printSummary(summary: Record<string, unknown>): void {
        const stats = summary.stats as Record<string, Stats>;
        const counts = summary.episodeCounts as Record<string, number>;
        console.log(
            `[RideTelemetry] ${summary.title} — ${summary.samples} samples / ${summary.seconds}s`
            + `${summary.truncated ? ' (TRUNCATED at cap)' : ''}`
            + `  episodes: float=${counts.float} sink=${counts.sink} lag=${counts.lag}`,
        );
        console.log(
            `[RideTelemetry] wheelBottomOffset ${((summary.wheelBottomOffset as number) * 100).toFixed(1)} cm`
            + ' (rendered tyre bottoms above the origin plane — adds to every visible gap)',
        );
        console.table(Object.entries(stats).map(([metric, v]) => ({
            metric, min: v.min, mean: v.mean, p95: v.p95, max: v.max,
        })));
        console.log('[RideTelemetry] worst episodes', summary.worstEpisodes);
        console.log('[RideTelemetry] full per-frame log: window.__rideTelemetry.dump()');
    }

    /** Serialises meta + every sample + summary + episodes and downloads it. */
    private _export(reason: string): void {
        if (typeof document === 'undefined' || this._count === 0) return;
        const c = cfg.debug.rideTelemetry;
        const lines: string[] = [];
        lines.push(JSON.stringify({
            type: 'meta',
            reason,
            startedAt: this._startedAt,
            columns: COLUMNS,
            wheelBottomOffset: this._car.wheelBottomOffset,
            // The knobs any analysis of this file needs to know verbatim.
            config: {
                floatThreshold: c.floatThreshold,
                sinkThreshold: c.sinkThreshold,
                pitchLagThreshold: c.pitchLagThreshold,
                heightResponse: cfg.car.suspension.heightResponse,
                tiltResponse: cfg.car.suspension.tiltResponse,
                maxGroundGap: cfg.car.suspension.maxGroundGap,
                slopeAmplitude: cfg.road.slopeAmplitude,
                slopeFrequency: cfg.road.slopeFrequency,
                curveAmplitude: cfg.road.curveAmplitude,
                curveFrequency: cfg.road.curveFrequency,
                bandLength: cfg.roadSurface.bandLength,
                segmentsPerBand: cfg.roadSurface.segmentsPerBand,
            },
        }));
        const n = this._count;
        for (let i = 0; i < n; i++) {
            const row: Record<string, number> = {};
            for (let k = 0; k < COLUMNS.length; k++) {
                row[COLUMNS[k]] = Math.round(this._data[k][i] * 10000) / 10000;
            }
            lines.push(JSON.stringify(row));
        }
        const summary = this._lastSummary ?? this._summarize(reason);
        lines.push(JSON.stringify({ type: 'summary', summary }));
        for (const episode of this._episodes) lines.push(JSON.stringify({ type: 'episode', episode }));

        const blob = new Blob([lines.join('\n')], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `ride-telemetry-${reason.replace(/\W+/g, '-')}-${Date.now()}.ndjson`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        console.log(`[RideTelemetry] wrote ${n} samples to ${anchor.download}`);
    }
}