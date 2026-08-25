import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { mulberry32 } from './random';
import { mergeGeometries, paintGeometry } from './mergeGeometry';

/**
 * tree — low-poly conifer geometry, one merged indexed mesh per variant.
 *
 * NOT a port of `Procedural_3D_world`'s tree generator, and that was a measured
 * decision rather than a shortcut. P3W builds a real branch skeleton, tubes it,
 * and hangs foliage sprays on it: **38,900 triangles and 2.9MB per tree**, 8.1ms
 * to generate on a desktop. Its own cheap tier (`ringDetail: 0.4`) only reaches
 * 38,216, because it thins the branch rings and the triangles are in the
 * foliage. The whole scene here runs at ~35,000 triangles, so a single P3W tree
 * would more than double it and fifty would be 1.9 million. It's a desktop
 * showcase asset; this is a mobile playable.
 *
 * What IS taken from P3W is everything around the geometry: the scatter
 * algorithm, the variant-pool-plus-instancing pattern, no textures with colour
 * baked per-vertex, and roughly its conifer proportions (a flared trunk under
 * stacked conical tiers).
 *
 * The result is ~60 triangles a tree, which is what makes a forest of a few
 * hundred affordable at all.
 */

/** A generated variant: its mesh, plus the dimensions a billboard must match. */
export interface TreeVariant {
    geometry: THREE.BufferGeometry;
    /** Total height, ground to tip. */
    height: number;
    /** Widest canopy diameter. */
    width: number;
}

/** Builds one tree variant. `seed` decides its proportions, so variants differ. */
export function createTreeGeometry(seed: number): TreeVariant {
    const t = cfg.trees;
    const rand = mulberry32(seed);
    const between = (min: number, max: number) => min + rand() * (max - min);

    const height = between(t.heightMin, t.heightMax);
    const trunkHeight = height * between(0.24, 0.34);
    const trunkRadius = height * t.trunkRadiusK;
    const tiers = Math.round(between(t.tiersMin, t.tiersMax));

    const parts: THREE.BufferGeometry[] = [];

    // Trunk: tapered, and slightly wider at the base so it reads as flared
    // rather than as a dowel. Open-ended — the canopy covers the top and the
    // ground covers the bottom, so caps would be invisible triangles.
    const trunk = new THREE.CylinderGeometry(
        trunkRadius * 0.72, trunkRadius * 1.25, trunkHeight, t.trunkSegments, 1, true,
    );
    trunk.translate(0, trunkHeight / 2, 0);
    parts.push(paintGeometry(trunk.toNonIndexed().clone(), new THREE.Color(t.trunkColor)));

    // Canopy: overlapping cones, each narrower and shorter than the one below.
    // Overlap matters — a gap between tiers reads as a stack of hats.
    const canopyBase = trunkHeight * 0.62;
    const canopyHeight = height - canopyBase;
    const lowest = new THREE.Color(t.foliageLowColor);
    const highest = new THREE.Color(t.foliageHighColor);
    const shade = new THREE.Color();

    for (let i = 0; i < tiers; i++) {
        const f = i / Math.max(1, tiers - 1);
        const tierRadius = height * t.canopyRadiusK * (1 - f * 0.62);
        const tierHeight = (canopyHeight / tiers) * between(1.5, 1.75);
        const y = canopyBase + (canopyHeight / tiers) * i;

        const cone = new THREE.ConeGeometry(tierRadius, tierHeight, t.canopySegments, 1, true);
        cone.translate(0, y + tierHeight / 2, 0);
        // Higher tiers catch more light. Baked per-tier rather than per-vertex:
        // a whole extra gradient per cone buys nothing at the distance these are
        // actually seen from.
        shade.copy(lowest).lerp(highest, f * 0.85 + rand() * 0.15);
        parts.push(paintGeometry(cone.toNonIndexed().clone(), shade));
    }

    // toNonIndexed() drops the index, so re-index trivially for the merge —
    // flat shading is what we want anyway, and each face already has its own
    // vertices.
    const indexed = parts.map((part) => {
        const count = part.attributes.position.count;
        const index = new Uint16Array(count);
        for (let i = 0; i < count; i++) index[i] = i;
        part.setIndex(new THREE.BufferAttribute(index, 1));
        return part;
    });

    const merged = mergeGeometries(indexed);
    merged.computeBoundingSphere();
    // Widest tier is the lowest one; see the canopy loop above.
    return { geometry: merged, height, width: height * t.canopyRadiusK * 2 };
}

/** One material for every variant — colour comes from the baked attribute. */
export function createTreeMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.85,
        // Flat shading suits the low-poly look and means the cones read as
        // faceted tiers instead of smooth blobs.
        flatShading: true,
    });
}
