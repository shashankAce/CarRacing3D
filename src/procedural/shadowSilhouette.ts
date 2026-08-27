import * as THREE from 'three';

/**
 * shadowSilhouette — snapshots a caster's shadow shape, once, at boot.
 *
 * ## Why a snapshot is exact and not an approximation
 *
 * A shadow on flat ground is the caster's silhouette projected along the light.
 * Render the caster with an ORTHOGRAPHIC camera looking along the light and you
 * have that silhouette directly. Laying it on the ground is then a pure 2D
 * transform, and the algebra says exactly which one.
 *
 * Build a basis from the sun direction S (pointing at the sun, elevation θ, with
 * ground direction g):
 *
 *     R = normalise(up × S)  = (g.z, 0, -g.x)      horizontal, across the light
 *     U = S × R              = (-sinθ·g.x, cosθ, -sinθ·g.z)
 *
 * Project each onto the ground along -S. R is already horizontal, so it maps
 * 1:1. For U, a point at U lands at U - S·(U.y / S.y), which works out to
 * -g / sinθ: a ground vector of length **1/sin(elevation)** pointing AWAY from
 * the sun.
 *
 * So the baked image maps to the ground by scaling its vertical axis by
 * 1/sinθ and rotating it to face down-light. Nothing is faked — at an 8 degree
 * sun that is a 7.2x stretch, which is the real length. And because the caster's
 * base sits at U = 0, which projects to itself, the near edge of the shadow stays
 * pinned under the object however far the far end runs.
 *
 * ## Why it can be baked at all
 *
 * Because time is resolved ONCE at boot and never advances mid-session, the light
 * direction is a constant. Every shadow in the game is therefore a fixed image,
 * and the per-frame work collapses to a scale, a rotate and a translate.
 *
 * Any geometry works, so real car models drop in without special handling — the
 * bounds and the silhouette both come out of the mesh.
 */

/**
 * The light's frame. Returned separately because the decal placement needs the
 * same vectors the bake used, and deriving them twice invites a sign error.
 */
export function lightFrame(sunDir: { x: number; y: number; z: number }) {
    const S = new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z).normalize();
    // Guard a near-vertical sun, where "across the light" is undefined.
    const horizontal = Math.hypot(S.x, S.z);
    const R = horizontal > 1e-4
        ? new THREE.Vector3(S.z / horizontal, 0, -S.x / horizontal)
        : new THREE.Vector3(1, 0, 0);
    const U = new THREE.Vector3().crossVectors(S, R).normalize();
    // sin(elevation) — how much the shadow stretches, and it diverges at 0.
    const sinElev = Math.max(0.03, S.y);
    // Ground direction the shadow runs along: away from the sun.
    const groundLen = horizontal > 1e-4 ? horizontal : 1;
    const gx = -S.x / groundLen, gz = -S.z / groundLen;
    return { S, R, U, sinElev, groundX: gx, groundZ: gz, heading: Math.atan2(gx, gz) };
}

/**
 * Light-frame bounds of a caster, padded. `r` is across the light and `u` is the
 * light image's own up axis — both PERPENDICULAR to the light direction, so this
 * is the caster's extent as the light sees it, not as the ground does.
 *
 * The padding is what keeps the silhouette off the edge of its render target. A
 * shape touching the border comes back with a straight cut across it, and in an
 * atlas it also bleeds into the neighbouring cell under bilinear filtering. 4%
 * is comfortably more than the one texel that strictly needs protecting.
 */
export function silhouetteBounds(
    geometries: THREE.BufferGeometry[],
    frame: ReturnType<typeof lightFrame>,
) {
    let rMin = Infinity, rMax = -Infinity, uMin = Infinity, uMax = -Infinity;
    const corner = new THREE.Vector3();
    for (const geometry of geometries) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        for (let i = 0; i < 8; i++) {
            corner.set(
                i & 1 ? box.max.x : box.min.x,
                i & 2 ? box.max.y : box.min.y,
                i & 4 ? box.max.z : box.min.z,
            );
            const r = corner.dot(frame.R), u = corner.dot(frame.U);
            if (r < rMin) rMin = r; if (r > rMax) rMax = r;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        }
    }
    const padR = (rMax - rMin) * 0.04 + 1e-3;
    const padU = (uMax - uMin) * 0.04 + 1e-3;
    return { rMin: rMin - padR, rMax: rMax + padR, uMin: uMin - padU, uMax: uMax + padU };
}

/** One caster's cell in a `ShadowAtlas`. */
export interface AtlasCell {
    /** Light-frame bounds of the silhouette, relative to the caster's ORIGIN. */
    rMin: number;
    uMin: number;
    /** Reciprocal spans, so the shader normalises with a multiply. */
    invSpanR: number;
    invSpanU: number;
    /** Index into the atlas grid, counted from the bottom-left, row-major. */
    cell: number;
}

export interface ShadowAtlas {
    texture: THREE.Texture;
    /**
     * Metres the red channel's 0..1 encodes — the tallest caster in the atlas.
     *
     * The atlas stores more than coverage. Alpha is the silhouette, and RED is
     * the HIGHEST point of caster geometry along that light ray. That second
     * channel is what lets a raised receiver reject an occluder beneath it: a
     * shadow lookup with no depth test says "this ray is blocked somewhere", and
     * a fragment 1.7m up needs "blocked ABOVE 1.7m". Without it the shadow on a
     * car appears ~11m before the tree's shadow on the road at a 12 degree sun,
     * and two misaligned shadows read worse than one missing one.
     */
    heightScale: number;
    /**
     * The green channel encodes the nearest caster surface along the light ray.
     * Reconstruct with `depthMin + (1 - green) / depthInvSpan`.
     *
     * `depth` means `-dot(position, S)`: larger is farther down-light. Storing
     * the nearest (smallest) value lets receivers reject the part of an atlas
     * footprint that is still BETWEEN that particular surface and the sun.
     * A centre-origin `d > 0` test cannot do this: a front wheel may itself sit
     * slightly sunward of the vehicle origin, while its perfectly valid shadow
     * starts there.
     */
    depthMin: number;
    depthInvSpan: number;
    /** Kept so the bake can be read back and verified; nothing else needs it. */
    target: THREE.WebGLRenderTarget;
    cols: number;
    rows: number;
    cells: AtlasCell[];
}

/**
 * Bakes every caster's silhouette into ONE texture, as a grid of square cells.
 *
 * An atlas rather than a texture each because the receiver shader samples the
 * silhouette inside a loop over casters, and GLSL will not index an array of
 * samplers with a non-constant. One sampler plus a per-caster UV rect is the
 * only shape this can take.
 *
 * NO MIPMAPS, deliberately, for two independent reasons: a mip chain averages
 * across cell borders, so one caster's shadow bleeds into another's at distance;
 * and the fetch happens under non-uniform control flow (a caster is skipped when
 * the fragment falls outside its footprint), where implicit derivatives — and
 * therefore automatic LOD selection — are undefined. With a single level there
 * is no LOD to select.
 */
export function bakeShadowAtlas(
    renderer: THREE.WebGLRenderer,
    casters: THREE.BufferGeometry[][],
    frame: ReturnType<typeof lightFrame>,
    cellSize: number,
): ShadowAtlas {
    const n = Math.max(1, casters.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    const target = new THREE.WebGLRenderTarget(cols * cellSize, rows * cellSize, {
        format: THREE.RGBAFormat,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        // Deliberately no colorSpace — see the note in `bakeShadowSilhouette`
        // and ARCHITECTURE.md gotcha 15. Only alpha is read anyway.
    });

    // Tallest caster in the set, which the red channel is normalised against.
    // Also find the light-axis extent. Green stores the *nearest* geometry
    // depth in each pixel; MAX blending can retain a minimum by encoding it
    // upside-down (near = 1, far = 0).
    let heightScale = 1e-3;
    let depthMin = Infinity, depthMax = -Infinity;
    const corner = new THREE.Vector3();
    for (const geometries of casters) {
        for (const geometry of geometries) {
            geometry.computeBoundingBox();
            const box = geometry.boundingBox!;
            heightScale = Math.max(heightScale, box.max.y);
            for (let i = 0; i < 8; i++) {
                corner.set(
                    i & 1 ? box.max.x : box.min.x,
                    i & 2 ? box.max.y : box.min.y,
                    i & 4 ? box.max.z : box.min.z,
                );
                const depth = -corner.dot(frame.S);
                depthMin = Math.min(depthMin, depth);
                depthMax = Math.max(depthMax, depth);
            }
        }
    }
    if (!Number.isFinite(depthMin)) { depthMin = 0; depthMax = 1; }
    const depthInvSpan = 1 / Math.max(1e-3, depthMax - depthMin);

    // Alpha = coverage, red = the highest caster geometry along this ray,
    // green = the nearest surface along that ray.
    //
    // MAX blending with no depth test is what makes the red channel mean that:
    // every fragment of every part writes its own height and the largest
    // survives, so a canopy at 11m wins over the trunk at 2m on the same ray.
    // An opaque draw would have left whichever triangle happened to be last.
    //
    // DoubleSide so open or planar geometry (a leaf card, a cut-out) still fills
    // its silhouette. It cannot change the result for a closed mesh, where the
    // front hull is the silhouette by definition.
    const material = new THREE.ShaderMaterial({
        uniforms: {
            uHeightScale: { value: heightScale },
            uDepthMin: { value: depthMin },
            uDepthInvSpan: { value: depthInvSpan },
            uShadowSun: { value: frame.S },
        },
        vertexShader: `
            uniform vec3 uShadowSun;
            varying float vHeight;
            varying float vDepth;
            void main() {
                // Local y: caster geometry is authored with its base at 0, so
                // this is height above the caster's own footing.
                vHeight = position.y;
                vDepth = -dot(position, uShadowSun);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uHeightScale;
            uniform float uDepthMin;
            uniform float uDepthInvSpan;
            varying float vHeight;
            varying float vDepth;
            void main() {
                float nearDepth = 1.0 - clamp((vDepth - uDepthMin) * uDepthInvSpan, 0.0, 1.0);
                gl_FragColor = vec4(clamp(vHeight / uHeightScale, 0.0, 1.0), nearDepth, 0.0, 1.0);
            }
        `,
        side: THREE.DoubleSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.MaxEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
    });

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevScissorTest = renderer.getScissorTest();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevViewport = new THREE.Vector4();
    renderer.getViewport(prevViewport);
    const prevScissor = new THREE.Vector4();
    renderer.getScissor(prevScissor);

    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    // Cleared once above; each cell then renders into its own scissored slice
    // without wiping the ones already done.
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    const cells: AtlasCell[] = [];
    const centre = new THREE.Vector3();

    for (let i = 0; i < casters.length; i++) {
        const geometries = casters[i];
        const b = silhouetteBounds(geometries, frame);

        const scene = new THREE.Scene();
        for (const geometry of geometries) scene.add(new THREE.Mesh(geometry, material));

        // Orthographic, looking ALONG the light with `up` = U, so image x is R
        // and image y is U. Integrating along the light is exactly what makes
        // the result a shadow rather than a picture.
        const camera = new THREE.OrthographicCamera(
            (b.rMin - b.rMax) * 0.5, (b.rMax - b.rMin) * 0.5,
            (b.uMax - b.uMin) * 0.5, (b.uMin - b.uMax) * 0.5,
            0.01, 1000,
        );
        centre.set(0, 0, 0)
            .addScaledVector(frame.R, (b.rMin + b.rMax) * 0.5)
            .addScaledVector(frame.U, (b.uMin + b.uMax) * 0.5);
        camera.position.copy(centre).addScaledVector(frame.S, 100);
        camera.up.copy(frame.U);
        camera.lookAt(centre);
        camera.updateProjectionMatrix();

        // Cell origin counted from the BOTTOM-left, matching both the GL
        // viewport's origin and the v axis of the UVs the shader builds.
        const cx = (i % cols) * cellSize;
        const cy = Math.floor(i / cols) * cellSize;
        renderer.setViewport(cx, cy, cellSize, cellSize);
        renderer.setScissor(cx, cy, cellSize, cellSize);
        renderer.render(scene, camera);

        cells.push({
            rMin: b.rMin,
            uMin: b.uMin,
            invSpanR: 1 / (b.rMax - b.rMin),
            invSpanU: 1 / (b.uMax - b.uMin),
            cell: i,
        });
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setScissorTest(prevScissorTest);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setViewport(prevViewport);
    renderer.setScissor(prevScissor);
    material.dispose();

    return { texture: target.texture, target, cols, rows, cells, heightScale, depthMin, depthInvSpan };
}
