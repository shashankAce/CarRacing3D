import { gameConfig as cfg } from '../config/gameConfig';
import { heightRowAt, heightInRow, type HeightRow } from './heightField';
import { terrainColorAt } from './terrainColor';
import { fillShadeGrid, makeShadeGrid, shadeAt, type ShadeGrid } from './terrainShadow';

/**
 * chunkMesh — builds one terrain chunk's vertex data.
 *
 * Ported from `Procedural_3D_world/src/terrain/chunkMesh.js`, with four
 * changes for streaming:
 *
 *  1. **It fills caller-owned buffers instead of creating a BufferGeometry.**
 *     Every chunk at a given resolution has identical topology and identical
 *     buffer sizes, so the streamer allocates its buffers once at startup and
 *     rewrites them on recycle. Driving forever allocates nothing.
 *  2. **Indices are built once and shared by every chunk** — same reason.
 *  3. **Local Z runs NEGATIVE** (0 → -size), because forward is -Z and a chunk
 *     covering larger world Z renders further away. See the winding note below,
 *     and the normal-sign note in `fillChunkBuffers`.
 *  4. **Normals come from the sampled grid, not from analytic derivatives.**
 *     The original called the height field five times per vertex — once for the
 *     height, four more for a central-difference normal. Measured on a low-end
 *     phone that was 4.3ms per chunk, 26% of a frame. Sampling one ring beyond
 *     the chunk and differencing the heights already in hand costs ~1 field
 *     evaluation per vertex instead of 5: measured 6.3x faster.
 *
 * Kept from the original: sampling from absolute world position (so neighbours
 * stitch with no cross-chunk coordination — the border ring means both sides of
 * a seam compute the identical normal from identical samples), and the skirt, a
 * wall hung off the border hiding any crack against a neighbour.
 *
 * CAVEAT for a future LOD: grid normals assume neighbours share the same vertex
 * spacing. Chunks at different resolutions would difference over different steps
 * and disagree on their shared edge normals — a shading seam the skirt cannot
 * hide. Analytic normals don't have that problem, so LOD tiers will need either
 * a fixed step for normals or a return to `normalAt` at chunk borders.
 */

/** Perimeter vertex indices of a res×res grid, walked once around as a closed loop. */
function perimeterIndices(res: number): number[] {
    const perimeter: number[] = [];
    for (let i = 0; i < res; i++) perimeter.push(i);                            // top,    L→R
    for (let j = 1; j < res; j++) perimeter.push(j * res + (res - 1));          // right,  T→B
    for (let i = res - 2; i >= 0; i--) perimeter.push((res - 1) * res + i);     // bottom, R→L
    for (let j = res - 2; j >= 1; j--) perimeter.push(j * res);                 // left,   B→T
    return perimeter;
}

/** Total vertices per chunk: the grid, plus one skirt vertex per perimeter vertex. */
export function chunkVertexCount(res: number): number {
    return res * res + perimeterIndices(res).length;
}

/**
 * The index buffer, identical for every chunk of this resolution.
 *
 * Winding note: the grid is mirrored on Z (local z goes 0 → -size), and
 * mirroring flips triangle orientation. So where the original emitted
 * `(a, c, b)` / `(b, c, d)`, this emits `(a, b, c)` / `(b, d, c)` — one
 * reversal to cancel the one mirror, leaving front faces pointing up. Get this
 * wrong and the terrain doesn't shade oddly, it vanishes: backface culling
 * discards it while the explicit normals keep lighting looking correct on
 * whatever is left.
 */
export function buildChunkIndices(res: number): Uint16Array | Uint32Array {
    const segs = res - 1;
    const gridCount = res * res;
    const perimeter = perimeterIndices(res);
    const n = perimeter.length;

    const indices: number[] = [];
    for (let j = 0; j < segs; j++) {
        for (let i = 0; i < segs; i++) {
            const a = j * res + i, b = a + 1, c = a + res, d = c + 1;
            indices.push(a, b, c, b, d, c);
        }
    }
    // Both winding orders on the skirt wall only. Cheaper than working out
    // which single winding faces outward on each of the four edges, and
    // cheaper than making the whole terrain material double-sided for it.
    for (let k = 0; k < n; k++) {
        const topA = perimeter[k], topB = perimeter[(k + 1) % n];
        const botA = gridCount + k, botB = gridCount + ((k + 1) % n);
        indices.push(topA, botA, topB, topB, botA, botB);
        indices.push(topA, topB, botA, topB, botB, botA);
    }

    const total = gridCount + n;
    return total > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}

const _color = { r: 0, g: 0, b: 0 };
const _row: HeightRow = { centreX: 0, level: 0 };

/**
 * Height samples for one chunk plus a one-vertex border ring, reused across every
 * build. Allocated on first use and only reallocated if the resolution changes.
 */
let _heights: Float64Array | null = null;
let _heightsSide = 0;

/**
 * Terrain self-shadow lattice for this chunk, reused across every build. Coarser
 * than the vertex grid on purpose — see `terrainShadow.ts` for why, and for the
 * chunk-build cost that forced it.
 */
let _shade: ShadeGrid | null = null;

/**
 * Fills one chunk's vertex data. `cx`/`cz` are chunk grid coordinates; the
 * chunk covers world X `[cx*chunkWidth, (cx+1)*chunkWidth]` and world Z
 * `[cz*chunkLength, (cz+1)*chunkLength]`.
 *
 * Positions are LOCAL to the chunk — the caller places the mesh at
 * `(cx*chunkWidth, 0, travelled - cz*chunkLength)`, which is what turns a
 * fixed local mesh into the right spot in a scrolling world.
 */
export function fillChunkBuffers(
    cx: number,
    cz: number,
    res: number,
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    colors: Float32Array,
): void {
    const sizeX = cfg.terrain.chunkWidth, sizeZ = cfg.terrain.chunkLength;
    const segs = res - 1;
    // Independent per axis — a chunk need not be square. The grid still has
    // the same VERTEX COUNT (res x res) on both axes; only the world-space
    // distance each step covers differs.
    const stepX = sizeX / segs, stepZ = sizeZ / segs;
    const originX = cx * sizeX, originZ = cz * sizeZ;
    const perimeter = perimeterIndices(res);
    const skirtDepth = cfg.terrain.skirtDepth;

    // ── Pass 1: sample heights, one ring wider than the chunk ─────────────
    // The extra ring is what lets an edge vertex difference against a real
    // neighbour instead of a one-sided guess, so two chunks meeting at a seam
    // compute the same normal from the same samples.
    const side = res + 2;
    if (_heightsSide !== side || _heights === null) {
        _heights = new Float64Array(side * side);
        _heightsSide = side;
    }
    const heights = _heights;

    for (let j = 0; j < side; j++) {
        const worldZ = originZ + (j - 1) * stepZ;
        // Road terms depend only on z — hoisted out of the x scan.
        heightRowAt(worldZ, _row);
        const rowBase = j * side;
        for (let i = 0; i < side; i++) {
            heights[rowBase + i] = heightInRow(originX + (i - 1) * stepX, worldZ, _row);
        }
    }

    // ── Pass 1b: the self-shadow lattice ─────────────────────────────────
    // Marched toward the light on its own coarse grid, then sampled per vertex
    // below. Allocated on first build; `makeShadeGrid` reads the chunk size and
    // spacing from config, both fixed for the session.
    if (_shade === null) _shade = makeShadeGrid();
    const shade = _shade;
    fillShadeGrid(originX, originZ, shade);

    // ── Pass 2: write vertices, differencing the grid for normals ─────────
    // Separate divisors per axis: the `heights` grid steps X and Z at
    // `stepX`/`stepZ` respectively, so a non-square chunk needs a non-square
    // gradient — using one shared divisor here would scale the X or Z slope
    // wrong on any chunk where they differ, tilting every normal.
    const invTwoStepX = 1 / (2 * stepX);
    const invTwoStepZ = 1 / (2 * stepZ);
    let pi = 0, ni = 0, ui = 0, ci = 0;
    for (let j = 0; j < res; j++) {
        const localZ = j * stepZ;
        const worldZ = originZ + localZ;
        const rowBase = (j + 1) * side;
        for (let i = 0; i < res; i++) {
            const localX = i * stepX;
            const idx = rowBase + i + 1;
            const h = heights[idx];

            const dx = (heights[idx + 1] - heights[idx - 1]) * invTwoStepX;
            const dZ = (heights[idx + side] - heights[idx - side]) * invTwoStepZ;
            const len = Math.sqrt(dx * dx + 1 + dZ * dZ);
            // The normal is in the chunk's LOCAL frame, whose z is mirrored
            // (local z = -(worldZ - originZ)). Mirroring an axis flips that
            // component of the normal, so local z is +dZ where world z would be
            // -dZ.
            //
            // This was backwards before the grid-normal rewrite. Checking the
            // emitted normals against the geometric normals of the emitted
            // triangles: worst agreement is a 0.993 dot with the correct sign
            // (~7°) versus 0.793 with the wrong one (~37° of error on the
            // steepest faces). Not fully inverted — ny dominates, so nothing
            // ends up back-facing — but slopes along the travel axis were
            // mis-shaded. It hid well because the colour bands read only ny.
            const nx = -dx / len, ny = 1 / len, nz = dZ / len;

            terrainColorAt(originX + localX, h, worldZ, ny, _color);

            // Self-shadow, multiplied into the albedo. The vertex colour is
            // LINEAR (see terrainColor.ts), so a plain multiply is the right
            // operation here and needs no encoding step. It darkens the ambient
            // term along with the sun's, which is not strictly right — a
            // shadowed slope still sees the sky — but the sun is 3.3 against
            // 0.55 of ambient, so the error is small and it costs one multiply.
            const lit = shadeAt(shade, localX, localZ);
            _color.r *= lit; _color.g *= lit; _color.b *= lit;

            positions[pi++] = localX; positions[pi++] = h; positions[pi++] = -localZ;
            normals[ni++] = nx; normals[ni++] = ny; normals[ni++] = nz;
            uvs[ui++] = i / segs; uvs[ui++] = j / segs;
            colors[ci++] = _color.r; colors[ci++] = _color.g; colors[ci++] = _color.b;
        }
    }

    // Skirt: each perimeter vertex duplicated and dropped straight down,
    // carrying its source's normal/uv/colour so the wall blends into the
    // terrain's shading rather than reading as a distinct strip.
    for (let k = 0; k < perimeter.length; k++) {
        const src = perimeter[k];
        positions[pi++] = positions[src * 3];
        positions[pi++] = positions[src * 3 + 1] - skirtDepth;
        positions[pi++] = positions[src * 3 + 2];
        normals[ni++] = normals[src * 3]; normals[ni++] = normals[src * 3 + 1]; normals[ni++] = normals[src * 3 + 2];
        uvs[ui++] = uvs[src * 2]; uvs[ui++] = uvs[src * 2 + 1];
        colors[ci++] = colors[src * 3]; colors[ci++] = colors[src * 3 + 1]; colors[ci++] = colors[src * 3 + 2];
    }

}
