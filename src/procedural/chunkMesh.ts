import { gameConfig as cfg } from '../config/gameConfig';
import { heightAt, normalAt } from './heightField';
import { terrainColorAt } from './terrainColor';

/**
 * chunkMesh — builds one terrain chunk's vertex data.
 *
 * Ported from `Procedural_3D_world/src/terrain/chunkMesh.js`, with three
 * changes for streaming:
 *
 *  1. **It fills caller-owned buffers instead of creating a BufferGeometry.**
 *     Every chunk at a given resolution has identical topology and identical
 *     buffer sizes, so the streamer allocates its buffers once at startup and
 *     rewrites them on recycle. Driving forever allocates nothing.
 *  2. **Indices are built once and shared by every chunk** — same reason.
 *  3. **Local Z runs NEGATIVE** (0 → -size), because forward is -Z and a chunk
 *     covering larger world Z renders further away. See the winding note below.
 *
 * Kept from the original: sampling height and normal from absolute world
 * position (so neighbours stitch with no cross-chunk coordination), and the
 * skirt — a wall hung off the border, hiding any crack against a neighbour
 * built at a different resolution.
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

const _normal = { x: 0, y: 1, z: 0 };
const _color = { r: 0, g: 0, b: 0 };

/**
 * Fills one chunk's vertex data. `cx`/`cz` are chunk grid coordinates; the
 * chunk covers world X `[cx*size, (cx+1)*size]` and world Z
 * `[cz*size, (cz+1)*size]`.
 *
 * Positions are LOCAL to the chunk — the caller places the mesh at
 * `(cx*size, 0, travelled - cz*size)`, which is what turns a fixed local mesh
 * into the right spot in a scrolling world.
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
    const size = cfg.terrain.chunkSize;
    const segs = res - 1;
    const originX = cx * size, originZ = cz * size;
    const perimeter = perimeterIndices(res);
    const skirtDepth = cfg.terrain.skirtDepth;

    let pi = 0, ni = 0, ui = 0, ci = 0;
    for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
            const localX = (i / segs) * size;
            const localZ = (j / segs) * size;
            const worldX = originX + localX;
            const worldZ = originZ + localZ;

            const h = heightAt(worldX, worldZ);
            normalAt(worldX, worldZ, _normal);
            terrainColorAt(worldX, h, worldZ, _normal.y, _color);

            positions[pi++] = localX; positions[pi++] = h; positions[pi++] = -localZ;
            normals[ni++] = _normal.x; normals[ni++] = _normal.y; normals[ni++] = _normal.z;
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
