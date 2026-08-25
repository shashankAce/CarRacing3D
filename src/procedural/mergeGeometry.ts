import * as THREE from 'three';

/**
 * Concatenates indexed geometries carrying position, normal and colour into one.
 *
 * Hand-rolled rather than using `three/examples/jsm/utils/BufferGeometryUtils`:
 * that module is large and general, and pulling it in to call one function puts
 * bytes we can't spare into a 2MB budget on the hope that tree-shaking keeps
 * only what we use.
 *
 * Merging is not optional for scattered props. An InstancedMesh draws ONE
 * geometry, so a tree built as separate trunk and canopy meshes cannot be
 * instanced at all — it would be a draw call per part per tree.
 *
 * Every input must be indexed and must carry all three attributes; anything
 * else is a programming error here rather than a case worth handling.
 */
export function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let vertexCount = 0;
    let indexCount = 0;
    for (const part of parts) {
        vertexCount += part.attributes.position.count;
        const index = part.getIndex();
        if (!index) throw new Error('mergeGeometries: every part must be indexed');
        indexCount += index.count;
    }

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const indices = vertexCount > 65535
        ? new Uint32Array(indexCount)
        : new Uint16Array(indexCount);

    let vOffset = 0;
    let iOffset = 0;
    for (const part of parts) {
        const pos = part.attributes.position;
        const nrm = part.attributes.normal;
        const col = part.attributes.color;
        positions.set(pos.array as Float32Array, vOffset * 3);
        normals.set(nrm.array as Float32Array, vOffset * 3);
        colors.set(col.array as Float32Array, vOffset * 3);

        const index = part.getIndex()!;
        for (let i = 0; i < index.count; i++) indices[iOffset + i] = index.getX(i) + vOffset;

        vOffset += pos.count;
        iOffset += index.count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
    for (const part of parts) part.dispose();
    return merged;
}

/** Bakes a flat colour into a geometry's `color` attribute, adding it if absent. */
export function paintGeometry(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
}
