import { gameConfig as cfg } from '../config/gameConfig';
import { heightRowAt, heightInRow, type HeightRow } from './heightField';
import { smoothstep } from './math';

/**
 * terrainShadow — terrain that shadows ITSELF, baked into the vertex colour at
 * chunk build time.
 *
 * Why this exists at all: the terrain mesh has only ever had `receiveShadow`,
 * never `castShadow`. So no shadowing technique we have tried — the real-time
 * map or the baked decals — has ever made a hill shade the valley behind it or
 * a mountain lay a shadow down its own flank. That is the single largest piece
 * of missing shading in the scene, and no amount of work on DYNAMIC casters
 * (car, traffic, trees) addresses it.
 *
 * Why it is baked into the vertex colour rather than rendered: the terrain
 * already carries a per-vertex `color` attribute, rebuilt from scratch on every
 * chunk build and consumed via `vertexColors: true`. So a static shadow term
 * costs NOTHING at runtime — no extra draw call, no render target, no texture
 * fetch, no bundle bytes. It is paid once, on the CPU, in the chunk build that
 * was going to happen anyway.
 *
 * The bill lands entirely in chunk build time, which is the one place in this
 * game that genuinely cannot absorb much: `maxBuildsPerFrame` is 1, and the
 * history in `chunkMesh.ts` records 5 height-field evaluations per vertex
 * measuring 4.3ms per chunk on a low-end phone — about 3µs an evaluation. That
 * number is the whole reason for the two design choices below.
 *
 *  1. **The march runs on a COARSE LATTICE, not per vertex.** A naive march
 *     from all 289 vertices at 5 steps is 1,445 evaluations, ~4.3ms — a
 *     quarter of a frame, for a shading term that is inherently broad and
 *     smooth. On a 5m lattice it is 81 points × 5 steps = 405, roughly
 *     doubling the existing 361, and the result is bilinearly sampled at the
 *     vertices. `gridStep` MUST divide `chunkWidth` AND `chunkLength` exactly:
 *     that is what makes a chunk's edge lattice points land on the same world
 *     positions as its neighbour's, so both sides of a seam compute the
 *     identical value and there is no shading discontinuity to hide.
 *
 *  2. **Step distances ramp QUADRATICALLY,** not uniformly. Near the sample
 *     point a bump a metre high still occludes, so precision matters; 60m out
 *     only something mountain-sized can, and mountains are ~600m-wavelength
 *     ridges that a 25m gap cannot slip between. Five steps over a 70m reach
 *     land at 2.8, 11.2, 25.2, 44.8 and 70m.
 *
 * Occlusion is tested in ANGULAR terms — the occluder's height above the light
 * ray divided by the distance to it — so `softness` is a dimensionless slope
 * and means the same thing at 3m as at 70m. Softening at all is not an attempt
 * at a real penumbra; it is what stops the coarse lattice from producing a
 * stair-stepped shadow edge.
 */

export interface ShadeGrid {
    /** Lattice points along X and Z — independent, since a chunk need not be square. */
    sideX: number;
    sideZ: number;
    /** Metres between lattice points, per axis. */
    stepX: number;
    stepZ: number;
    /** Shade factor per lattice point: 1 fully lit, down to 1 - strength. */
    values: Float32Array;
}

const _row: HeightRow = { centreX: 0, level: 0 };

/** Unlit heights at the lattice points, and the running occlusion maximum. */
let _base = new Float64Array(0);
let _occ = new Float32Array(0);

/** The march frame, rebuilt by `refreshTerrainShadow`. */
let _initialised = false;
let _active = false;
let _tanElev = 1;
let _dist = new Float64Array(0);
let _offX = new Float64Array(0);
let _offZ = new Float64Array(0);

/**
 * Rebuilds the march direction from `lighting.sunDirection`.
 *
 * Must run AFTER `resolveTimeOfDay()`, which is what decides whether the scene
 * is lit by the sun or the moon and overwrites that vector accordingly — a
 * moonlit run self-shadows from the moon, which is the same code path. Called
 * lazily on first use as well, so a missed call degrades to correct-but-late
 * rather than to no shadows at all.
 */
export function refreshTerrainShadow(): void {
    _initialised = true;
    _active = false;

    const s = cfg.terrain.selfShadow;
    if (!s.enabled || s.strength <= 0 || s.steps < 1 || s.reach <= 0) return;

    // Render space mirrors Z (renderZ = travelled - worldZ) and the height
    // field is sampled in WORLD space, so the light's z flips on the way in.
    const d = cfg.lighting.sunDirection;
    const lx = d.x, ly = d.y, lz = -d.z;

    const horizontal = Math.hypot(lx, lz);
    // A light straight overhead casts nothing, and would divide by zero below.
    if (horizontal < 1e-6) return;

    // Clamped rather than switched off near the horizon. At a true sunset
    // elevation the shadow of a 30m mountain is hundreds of metres long, so a
    // 70m march sees only its near end and the terrain goes blotchy; clamping
    // keeps shadows long but bounded, and keeps the look continuous across the
    // sun/moon handover instead of popping.
    const elevation = Math.atan2(ly, horizontal);
    const floor = s.minElevationDegrees * Math.PI / 180;
    _tanElev = Math.tan(Math.max(elevation, floor));

    const steps = Math.round(s.steps);
    if (_dist.length !== steps) {
        _dist = new Float64Array(steps);
        _offX = new Float64Array(steps);
        _offZ = new Float64Array(steps);
    }
    const ux = lx / horizontal, uz = lz / horizontal;
    for (let k = 0; k < steps; k++) {
        const f = (k + 1) / steps;
        const t = s.reach * f * f;
        _dist[k] = t;
        _offX[k] = ux * t;
        _offZ[k] = uz * t;
    }
    _active = true;
}

/** Allocates the lattice for one chunk. Reused across every build. */
export function makeShadeGrid(): ShadeGrid {
    const sizeX = cfg.terrain.chunkWidth, sizeZ = cfg.terrain.chunkLength;
    const step = cfg.terrain.selfShadow.gridStep;
    const spansX = Math.max(1, Math.round(sizeX / step));
    const spansZ = Math.max(1, Math.round(sizeZ / step));
    if (Math.abs(spansX * step - sizeX) > 1e-6 || Math.abs(spansZ * step - sizeZ) > 1e-6) {
        console.warn(
            `[terrainShadow] selfShadow.gridStep ${step} does not divide ` +
            `terrain.chunkWidth ${sizeX} and/or terrain.chunkLength ${sizeZ} ` +
            'evenly. Chunk edges will not share lattice points with their ' +
            'neighbours and the terrain will show shading seams. Pick a ' +
            'divisor of both.',
        );
    }
    const sideX = spansX + 1, sideZ = spansZ + 1;
    return {
        sideX, sideZ, stepX: sizeX / spansX, stepZ: sizeZ / spansZ,
        values: new Float32Array(sideX * sideZ),
    };
}

/**
 * Fills one chunk's lattice with shade factors. `originX`/`originZ` are the
 * chunk's minimum corner in WORLD coordinates.
 */
export function fillShadeGrid(originX: number, originZ: number, grid: ShadeGrid): void {
    if (!_initialised) refreshTerrainShadow();

    const { sideX, sideZ, stepX, stepZ, values } = grid;
    const count = sideX * sideZ;
    if (!_active) { values.fill(1); return; }

    if (_base.length !== count) {
        _base = new Float64Array(count);
        _occ = new Float32Array(count);
    }

    // Pass 1: the unlit height at each lattice point, row by row so the road
    // terms hoist out of the x scan — same reason `fillChunkBuffers` does.
    for (let j = 0; j < sideZ; j++) {
        const z = originZ + j * stepZ;
        heightRowAt(z, _row);
        const rowBase = j * sideX;
        for (let i = 0; i < sideX; i++) {
            _base[rowBase + i] = heightInRow(originX + i * stepX, z, _row);
        }
    }

    // Pass 2: one march step at a time, NOT one lattice point at a time. Every
    // point in a lattice row shares the same offset, so at a fixed step the
    // whole row lands on a single world Z and `heightRowAt` still hoists. Point-
    // major order would give every sample its own Z and lose that entirely.
    _occ.fill(0);
    const softness = cfg.terrain.selfShadow.softness;
    for (let k = 0; k < _dist.length; k++) {
        const rayRise = _dist[k] * _tanElev;
        const invDist = 1 / _dist[k];
        const ox = _offX[k], oz = _offZ[k];
        for (let j = 0; j < sideZ; j++) {
            const z = originZ + j * stepZ + oz;
            heightRowAt(z, _row);
            const rowBase = j * sideX;
            for (let i = 0; i < sideX; i++) {
                const idx = rowBase + i;
                const h = heightInRow(originX + i * stepX + ox, z, _row);
                // How far the occluder stands above the light ray, per metre of
                // distance to it — an angle, so `softness` is scale-free.
                const excess = (h - _base[idx] - rayRise) * invDist;
                if (excess <= 0) continue;
                const o = smoothstep(0, softness, excess);
                if (o > _occ[idx]) _occ[idx] = o;
            }
        }
    }

    const strength = cfg.terrain.selfShadow.strength;
    for (let n = 0; n < count; n++) values[n] = 1 - strength * _occ[n];
}

/**
 * Bilinear shade factor at a position inside the chunk. `localX`/`localZ` are
 * POSITIVE metres from the chunk's minimum corner — the un-mirrored offsets the
 * height field was sampled at, not the mesh's negative local z.
 */
export function shadeAt(grid: ShadeGrid, localX: number, localZ: number): number {
    const { sideX, sideZ, stepX, stepZ, values } = grid;
    const lastX = sideX - 1, lastZ = sideZ - 1;

    const fx = localX / stepX, fz = localZ / stepZ;
    let i0 = Math.floor(fx), j0 = Math.floor(fz);
    if (i0 < 0) i0 = 0; else if (i0 > lastX) i0 = lastX;
    if (j0 < 0) j0 = 0; else if (j0 > lastZ) j0 = lastZ;
    const i1 = i0 < lastX ? i0 + 1 : lastX;
    const j1 = j0 < lastZ ? j0 + 1 : lastZ;
    const tx = fx - i0, tz = fz - j0;

    const near = values[j0 * sideX + i0] + (values[j0 * sideX + i1] - values[j0 * sideX + i0]) * tx;
    const far = values[j1 * sideX + i0] + (values[j1 * sideX + i1] - values[j1 * sideX + i0]) * tx;
    return near + (far - near) * tz;
}
