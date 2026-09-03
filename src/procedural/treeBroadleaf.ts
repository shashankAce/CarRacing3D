import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { mulberry32 } from './random';
import { mergeGeometries, paintGeometry } from './mergeGeometry';
import type { TreeVariant } from './tree';

/**
 * treeBroadleaf — the second tree family visible in
 * reference/design/game_refrence.png alongside the conifer `tree.ts` already
 * builds: a straight trunk that forks into a couple of short angled branches
 * under one deformed, rounded canopy blob, instead of a radially symmetric
 * cone stack. Same low-poly budget and construction pattern as `tree.ts`
 * (flat-shaded, vertex-painted, merged into one indexed mesh per variant) so
 * both families instance and impostor-bake identically — see
 * `ScatterStreamer`, which alternates between the two generators across
 * `trees.variants` + `trees.broadleaf.variants` slots.
 */

/** Builds one broadleaf variant. `seed` decides its proportions, so variants differ. */
export function createBroadleafTreeGeometry(seed: number): TreeVariant {
    const t = cfg.trees;
    const b = t.broadleaf;
    const rand = mulberry32(seed);
    const between = (min: number, max: number) => min + rand() * (max - min);

    const height = between(t.heightMin, t.heightMax);
    const trunkHeight = height * between(b.trunkHeightMinK, b.trunkHeightMaxK);
    const trunkRadius = height * b.trunkRadiusK;

    const parts: THREE.BufferGeometry[] = [];
    const trunkColor = new THREE.Color(t.trunkColor);

    // Trunk: same flared taper as the conifer's, open-ended for the same
    // reason — the canopy and the ground cover its ends.
    const trunk = new THREE.CylinderGeometry(
        trunkRadius * 0.72, trunkRadius * 1.25, trunkHeight, t.trunkSegments, 1, true,
    );
    trunk.translate(0, trunkHeight / 2, 0);
    parts.push(paintGeometry(trunk.toNonIndexed().clone(), trunkColor));

    // Branches: short capped stubs jutting out from the upper trunk, angled
    // away from vertical. Purely structural — they break up the silhouette
    // where the reference shows a fork or a stub below the canopy mass.
    const branchCount = Math.round(between(b.branchCountMin, b.branchCountMax));
    for (let i = 0; i < branchCount; i++) {
        const branchStartY = trunkHeight * between(0.5, 0.92);
        const branchLength = height * between(b.branchLengthMinK, b.branchLengthMaxK);
        const branchRadius = trunkRadius * 0.55;
        const azimuth = rand() * Math.PI * 2;
        const tilt = between(b.branchTiltMin, b.branchTiltMax);

        const branch = new THREE.CylinderGeometry(
            branchRadius * 0.7, branchRadius, branchLength, Math.max(3, t.trunkSegments - 1),
        );
        // Base pinned to the local origin so the rotations below pivot the
        // stub around its attachment point rather than its middle.
        branch.translate(0, branchLength / 2, 0);
        branch.rotateX(tilt);
        branch.rotateY(azimuth);
        branch.translate(
            Math.sin(azimuth) * trunkRadius * 0.6,
            branchStartY,
            Math.cos(azimuth) * trunkRadius * 0.6,
        );
        parts.push(paintGeometry(branch.toNonIndexed().clone(), trunkColor));
    }

    // Canopy: ONE icosahedron, deformed — each vertex pushed in/out along its
    // own radius by a random factor, then flattened vertically. A single
    // irregular blob rather than several overlapping ones, which is what
    // reads as "clumped foliage" instead of the conifer's clean radial cones.
    const canopyRadius = height * b.canopyRadiusK;
    const canopyBaseY = trunkHeight * 0.94;
    const lowest = new THREE.Color(t.foliageLowColor);
    const highest = new THREE.Color(t.foliageHighColor);
    const shade = new THREE.Color();

    const canopy = new THREE.IcosahedronGeometry(canopyRadius, b.canopyDetail);
    const canopyPos = canopy.attributes.position;
    const vertex = new THREE.Vector3();
    // IcosahedronGeometry is NOT indexed — every face owns its own private
    // copy of each corner it touches (PolyhedronGeometry only ever calls
    // setAttribute, never setIndex). Jittering each entry independently would
    // pull those copies apart at every corner shared between faces, which is
    // exactly "broken", gapped triangles. So corners at the same original
    // position share ONE jitter factor, looked up by a rounded position key.
    const jitterByCorner = new Map<string, number>();
    for (let i = 0; i < canopyPos.count; i++) {
        vertex.fromBufferAttribute(canopyPos, i);
        const key = `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)},${vertex.z.toFixed(4)}`;
        let jitter = jitterByCorner.get(key);
        if (jitter === undefined) {
            jitter = between(b.canopyJitterMin, b.canopyJitterMax);
            jitterByCorner.set(key, jitter);
        }
        vertex.multiplyScalar(jitter);
        canopyPos.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
    canopyPos.needsUpdate = true;
    canopy.scale(1, b.canopySquashY, 1);
    canopy.computeVertexNormals();

    // Per-vertex colour by height within the blob's own (now irregular)
    // bounds — higher vertices catch more light, same idea as the conifer's
    // per-tier shading, just continuous over one shape instead of stepped.
    // Also measures the jittered blob's actual extents rather than trusting
    // canopyRadius: outward jitter can push a vertex well past it, and an
    // under-measured `height`/`width` would clip this tree in the impostor
    // bake, which frames its camera to exactly those two numbers.
    let minY = Infinity, maxY = -Infinity, maxRadiusXZ = 0;
    for (let i = 0; i < canopyPos.count; i++) {
        const y = canopyPos.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const x = canopyPos.getX(i), z = canopyPos.getZ(i);
        const r = Math.sqrt(x * x + z * z);
        if (r > maxRadiusXZ) maxRadiusXZ = r;
    }
    const canopyColors = new Float32Array(canopyPos.count * 3);
    for (let i = 0; i < canopyPos.count; i++) {
        const f = (canopyPos.getY(i) - minY) / (maxY - minY || 1);
        shade.copy(lowest).lerp(highest, f * 0.85 + rand() * 0.15);
        canopyColors[i * 3] = shade.r;
        canopyColors[i * 3 + 1] = shade.g;
        canopyColors[i * 3 + 2] = shade.b;
    }
    canopy.setAttribute('color', new THREE.BufferAttribute(canopyColors, 3));
    const canopyOriginY = canopyBaseY + canopyRadius * 0.5;
    canopy.translate(0, canopyOriginY, 0);
    parts.push(canopy.toNonIndexed().clone());

    const indexed = parts.map((part) => {
        const count = part.attributes.position.count;
        const index = new Uint16Array(count);
        for (let i = 0; i < count; i++) index[i] = i;
        part.setIndex(new THREE.BufferAttribute(index, 1));
        return part;
    });

    const merged = mergeGeometries(indexed);
    merged.computeBoundingSphere();
    return {
        geometry: merged,
        height: Math.max(height, canopyOriginY + maxY),
        width: maxRadiusXZ * 2,
    };
}
