import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { lightFrame, bakeShadowAtlas, type ShadowAtlas } from '../procedural/shadowSilhouette';

/**
 * TreeShadowMask — hundreds of static casters, in one top-down texture.
 *
 * ## Why trees need a different mechanism from the car
 *
 * `ProjectedShadows` puts each caster in a uniform slot, which caps it at a
 * handful. `trees.maxInstances` is 400. No tuning bridges that, so the tree
 * shadows go into a TEXTURE instead of into uniforms: every near tree's
 * silhouette is drawn, already projected onto the ground plane, into one
 * orthographic top-down render target, and the ground materials sample it by
 * world XZ.
 *
 * That is one extra draw call — the quads are instanced — and one texture fetch
 * per ground fragment, for an unlimited number of casters.
 *
 * ## Why this drapes when the decal quads did not
 *
 * The decals failed on trees for a measured reason: a 14m tree at a 28 degree
 * sun projects 30m of ground, terrain amplitude is 5.5m, so a planar quad spends
 * most of its length underground. Here there is no quad in the world at all. The
 * mask is a function of ground POSITION, and the ground shader evaluates it at
 * whatever height that fragment actually sits at — so it drapes over any terrain
 * by construction, and burial is not a thing that can happen.
 *
 * ## Why the target is redrawn every frame
 *
 * The mask window is camera-relative, so its pixels represent different ground
 * as the car advances. A full redraw is one instanced draw into a small target
 * and cannot drift out of sync. The INSTANCE BUFFERS do not need to follow that
 * movement, though: centres are anchored in world Z and one uniform scrolls the
 * complete batch. They upload only when the visible caster set changes.
 *
 * ## Known limits
 *
 * GROUND ONLY. A lookup by world XZ gives every point of a vertical surface at
 * the same XZ the same value, so a tree shadow sampled on a tree trunk or a car
 * would be a vertical streak. Vehicles therefore do not sample this — they get
 * their shadows from `ProjectedShadows`, whose light-frame lookup is correct on
 * any surface orientation. A tree shadow falling across the car is the one thing
 * this split gives up.
 */
export class TreeShadowMask {
    private _atlas: ShadowAtlas | null = null;
    private _frame = lightFrame(cfg.lighting.sunDirection);
    private _casters: THREE.BufferGeometry[][] = [];

    private _target: THREE.WebGLRenderTarget;
    private _scene = new THREE.Scene();
    private _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
    private _mesh: THREE.Mesh;
    private _material: THREE.ShaderMaterial;

    /** Per-instance attributes, compared and rewritten from `add`. */
    private _centre: THREE.InstancedBufferAttribute;
    private _along: THREE.InstancedBufferAttribute;
    private _across: THREE.InstancedBufferAttribute;
    private _cell: THREE.InstancedBufferAttribute;
    private _geometry: THREE.InstancedBufferGeometry;

    private _live = 0;
    private _previousLive = 0;
    private _centreDirty = false;
    private _alongDirty = false;
    private _acrossDirty = false;
    private _cellDirty = false;
    /** World travel origin represented by the current centre buffer. */
    private _anchor = Number.NaN;
    /** World-space rect the mask currently covers: x0, z0, size. */
    private _rect = new THREE.Vector3();

    constructor() {
        const ts = cfg.lighting.treeShadows;
        const max = Math.max(1, Math.round(ts.maxCasters));

        this._target = new THREE.WebGLRenderTarget(ts.maskSize, ts.maskSize, {
            format: THREE.RGBAFormat,
            generateMipmaps: false,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            // No colorSpace, as everywhere else a render target is written —
            // three forces the working space and ignores the target's own.
            // Only alpha is read back anyway. ARCHITECTURE.md gotcha 15.
        });

        // A unit quad in the XZ plane, spanning -0.5..0.5, expanded per instance
        // by the along/across vectors the light frame implies.
        const quad = new THREE.InstancedBufferGeometry();
        quad.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([
            -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
        ]), 2));
        quad.setIndex([0, 1, 2, 0, 2, 3]);

        this._centre = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
        this._along = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
        this._across = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
        this._cell = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
        this._centre.setUsage(THREE.DynamicDrawUsage);
        this._along.setUsage(THREE.DynamicDrawUsage);
        this._across.setUsage(THREE.DynamicDrawUsage);
        this._cell.setUsage(THREE.DynamicDrawUsage);
        quad.setAttribute('iCentre', this._centre);
        quad.setAttribute('iAlong', this._along);
        quad.setAttribute('iAcross', this._across);
        quad.setAttribute('iCell', this._cell);
        quad.instanceCount = 0;
        this._geometry = quad;

        this._material = new THREE.ShaderMaterial({
            uniforms: {
                uAtlas: { value: null },
                uGrid: { value: new THREE.Vector4(1, 1, 1, 1) },
                uRect: { value: new THREE.Vector3() },
                uScrollZ: { value: 0 },
            },
            vertexShader: `
                attribute vec2 corner;
                attribute vec2 iCentre;
                attribute vec2 iAlong;
                attribute vec2 iAcross;
                attribute float iCell;
                uniform vec3 uRect;
                uniform float uScrollZ;
                varying vec2 vCellUv;
                varying float vCell;
                void main() {
                    // Ground position of this quad corner, in render-space XZ.
                    vec2 p = iCentre + iAcross * corner.x + iAlong * corner.y;
                    p.y += uScrollZ;
                    // Straight to clip space: the mask is an axis-aligned window,
                    // so there is no camera worth constructing for it.
                    vec2 ndc = (p - uRect.xy) / uRect.z * 2.0 - 1.0;
                    gl_Position = vec4(ndc, 0.0, 1.0);
                    vCellUv = corner + 0.5;
                    vCell = iCell;
                }
            `,
            fragmentShader: `
                precision mediump float;
                uniform sampler2D uAtlas;
                uniform vec4 uGrid;
                varying vec2 vCellUv;
                varying float vCell;
                void main() {
                    vec2 cell = vec2(mod(vCell, uGrid.x), floor(vCell * uGrid.z));
                    // Alpha is coverage, red is the occluder's height. Both are
                    // carried through under MAX blending, so where two canopies
                    // overlap the taller one's height survives — which is the
                    // right answer for "is anything above this fragment".
                    vec4 t = texture2D(uAtlas, (cell + vCellUv) * uGrid.zw);
                    gl_FragColor = vec4(t.r, 0.0, 0.0, t.a);
                }
            `,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            // MAX, not additive. Additive was wrong for a reason the readback
            // showed plainly: it SATURATES. Two overlapping canopies at 0.5 sum
            // to 1.0, so a clump of trees clips to a flat black blob with no
            // gradation left in it — the mask came back with max alpha already
            // pegged at 255. MAX keeps each silhouette's own falloff and is what
            // occlusion actually composites like.
            //
            // No extension check needed: three 0.185 dropped WebGL1 entirely, so
            // gl.MAX is always available.
            blending: THREE.CustomBlending,
            blendEquation: THREE.MaxEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneFactor,
            // REQUIRED, not laziness. The quad is built from the light frame:
            // `iAcross` and `iAlong` are derived from the sun's ground direction,
            // and the mask's NDC y maps to world Z. The screen-space winding is
            // therefore a function of the SUN AZIMUTH, and it changes sign as the
            // sun goes round — at the current angle the cross product is -0.999,
            // i.e. clockwise, so FrontSide culled every quad and the mask came
            // back completely empty while still reporting its draw call and its
            // 276 triangles. No fixed index order can be correct for every sun
            // direction, so the face test has to be off.
            side: THREE.DoubleSide,
        });

        this._mesh = new THREE.Mesh(quad, this._material);
        this._mesh.frustumCulled = false;
        this._scene.add(this._mesh);
    }

    /** Registers a tree variant's geometry and returns its handle. */
    register(geometry: THREE.BufferGeometry): number {
        this._casters.push([geometry]);
        return this._casters.length - 1;
    }

    /** Bakes the silhouette atlas. Needs a renderer, so it runs once one exists. */
    bake(renderer: THREE.WebGLRenderer): void {
        if (this._casters.length === 0) return;
        const ts = cfg.lighting.treeShadows;
        this._atlas = bakeShadowAtlas(renderer, this._casters, this._frame, ts.textureSize);
        this._material.uniforms.uAtlas.value = this._atlas.texture;
        const { cols, rows } = this._atlas;
        (this._material.uniforms.uGrid.value as THREE.Vector4)
            .set(cols, rows, 1 / cols, 1 / rows);
    }

    /** The mask texture, for the ground materials to sample. */
    get texture(): THREE.Texture { return this._target.texture; }
    /** Metres the mask's red channel encodes. Zero until `bake`. */
    get heightScale(): number { return this._atlas ? this._atlas.heightScale : 1; }
    /** The window the mask covers: x0, z0, size — the ground shader's uniform. */
    get rect(): THREE.Vector3 { return this._rect; }

    /**
     * Positions the window for this frame and starts the caster list.
     *
     * Biased AHEAD of the car rather than centred on it, because the ground
     * behind is off screen. Snapped to the texel grid: without that, sub-texel
     * movement makes every shadow edge crawl as the car drives, which reads as
     * the shadows shimmering rather than the world moving.
     */
    begin(carX: number, travelled: number): void {
        const ts = cfg.lighting.treeShadows;
        const size = ts.windowSize;
        const texel = size / ts.maskSize;
        // Keep both the instance centres and the shared offset small throughout
        // an infinite run. `add` will rewrite the live centres on this frame,
        // and its equality checks turn this periodic rebase into one upload.
        if (!Number.isFinite(this._anchor) || Math.abs(travelled - this._anchor) >= 512) {
            this._anchor = travelled;
        }
        this._material.uniforms.uScrollZ.value = travelled - this._anchor;
        // Forward is -Z, so biasing ahead means shifting the window negative.
        const cz = -size * ts.forwardBias;
        const x0 = Math.round((carX - size * 0.5) / texel) * texel;
        const z0 = Math.round((cz - size * 0.5) / texel) * texel;
        this._rect.set(x0, z0, size);
        (this._material.uniforms.uRect.value as THREE.Vector3).copy(this._rect);
        this._previousLive = this._live;
        this._live = 0;
        this._centreDirty = false;
        this._alongDirty = false;
        this._acrossDirty = false;
        this._cellDirty = false;
    }

    /**
     * Submits one tree. `groundY` is unused for placement — the mask has no
     * height axis, which is exactly why it drapes — but the caller still passes
     * the real surface so the signature matches the decal path it replaces.
     */
    add(handle: number, x: number, _groundY: number, worldZ: number, scale: number): void {
        if (this._atlas === null) return;
        const max = this._cell.count;
        if (this._live >= max) return;

        const r = this._rect;
        const cell = this._atlas.cells[handle];
        const f = this._frame;

        // Ground footprint. `across` maps 1:1 from the light's R axis; `along`
        // is the U extent divided by sin(elevation), the real projected length.
        const across = scale / cell.invSpanR;
        const along = scale / cell.invSpanU / f.sinElev;
        // The silhouette's centre offset, carried through the same transform.
        const offAcross = (cell.rMin + 0.5 / cell.invSpanR) * scale;
        const offAlong = (cell.uMin + 0.5 / cell.invSpanU) * scale / f.sinElev;

        // The across axis must be +R, and in world XZ that is (-groundZ,
        // groundX) — NOT (groundZ, -groundX), which is -R.
        //
        // Worth spelling out, because getting it backwards leaves the shadow
        // region pixel-identical and the silhouette MIRRORED: the footprint is a
        // rectangle either way, so any check on placement or extent passes while
        // every tree's shadow is flipped. It is only visible by comparing the
        // mask's UV against the light-frame UV, where the wrong sign shows up as
        // a 1.43 error against 0.0000.
        //
        //   R = (S.z/h, 0, -S.x/h)  and  ground = (-S.x/h, -S.z/h)
        //   so  R.x = -ground.z  and  R.z = ground.x
        const gx = f.groundX, gz = f.groundZ;
        const cx = x + gx * offAlong - gz * offAcross;
        // Store Z relative to a rolling world anchor. The shader adds the
        // current travel delta, producing `travelled - worldZ` without changing
        // this attribute on every frame.
        const cz = this._anchor - worldZ + gz * offAlong + gx * offAcross;
        const renderCz = Math.fround(cz)
            + (this._material.uniforms.uScrollZ.value as number);

        // Cheap reject: anything whose footprint cannot touch the window is not
        // worth an instance slot, and the near buckets hold trees well outside
        // it. Conservative — the radius is the footprint's own half-diagonal.
        const reach = (Math.abs(along) + Math.abs(across)) * 0.5;
        if (cx + reach < r.x || cx - reach > r.x + r.z
            || renderCz + reach < r.y || renderCz - reach > r.y + r.z) return;

        const i = this._live++;
        const centre = this._centre.array;
        const alongArray = this._along.array;
        const acrossArray = this._across.array;
        const cellArray = this._cell.array;
        const j = i * 2;
        // Compare in the attribute's real storage precision. Comparing its
        // float32 value with an unrounded JS double would report a false change
        // on almost every frame and silently defeat this optimization.
        const centreX = Math.fround(cx), centreZ = Math.fround(cz);
        const alongX = Math.fround(gx * along), alongZ = Math.fround(gz * along);
        const acrossX = Math.fround(-gz * across), acrossZ = Math.fround(gx * across);

        if (centre[j] !== centreX || centre[j + 1] !== centreZ) {
            centre[j] = centreX; centre[j + 1] = centreZ;
            this._centreDirty = true;
        }
        if (alongArray[j] !== alongX || alongArray[j + 1] !== alongZ) {
            alongArray[j] = alongX; alongArray[j + 1] = alongZ;
            this._alongDirty = true;
        }
        if (acrossArray[j] !== acrossX || acrossArray[j + 1] !== acrossZ) {
            acrossArray[j] = acrossX; acrossArray[j + 1] = acrossZ;
            this._acrossDirty = true;
        }
        if (cellArray[i] !== cell.cell) {
            cellArray[i] = cell.cell;
            this._cellDirty = true;
        }
    }

    /** Uploads the instance data. Call after the last `add`. */
    commit(): void {
        this._geometry.instanceCount = this._live;
        if (this._live === 0) return;
        // A shorter list only changes instanceCount. A longer list whose tail
        // happens to match already-uploaded stale data also needs no transfer;
        // the element comparisons in `add` are the source of truth.
        const rangeLive = Math.max(this._live, this._previousLive);
        this._uploadIfDirty(this._centre, this._centreDirty, rangeLive * 2);
        this._uploadIfDirty(this._along, this._alongDirty, rangeLive * 2);
        this._uploadIfDirty(this._across, this._acrossDirty, rangeLive * 2);
        this._uploadIfDirty(this._cell, this._cellDirty, rangeLive);
    }

    private _uploadIfDirty(
        attribute: THREE.InstancedBufferAttribute,
        dirty: boolean,
        count: number,
    ): void {
        if (!dirty) return;
        attribute.updateRanges = [{ start: 0, count }];
        attribute.needsUpdate = true;
    }

    /**
     * Renders the mask. Must run BEFORE the main scene render, since the ground
     * materials sample it in the same frame.
     */
    render(renderer: THREE.WebGLRenderer): void {
        if (this._atlas === null) return;

        const prevTarget = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;
        const prevClear = new THREE.Color();
        renderer.getClearColor(prevClear);
        const prevAlpha = renderer.getClearAlpha();

        // `renderer.info` resets on every `render` call, and this pass runs
        // during `update` — BEFORE the engine draws the scene. Left alone, the
        // perf HUD would read this pass's one draw call instead of the scene's
        // hundred, silently turning the most-watched counter in the game into a
        // constant 1. Snapshot and restore so the mask is invisible to it; the
        // mask's own cost is always exactly one instanced draw, reported as the
        // `mask` instance count on the HUD.
        const info = renderer.info.render;
        const prevCalls = info.calls, prevTris = info.triangles;
        const prevPoints = info.points, prevLines = info.lines;

        renderer.setRenderTarget(this._target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.autoClear = false;
        if (this._live > 0) renderer.render(this._scene, this._camera);

        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAutoClear;
        renderer.setClearColor(prevClear, prevAlpha);
        info.calls = prevCalls; info.triangles = prevTris;
        info.points = prevPoints; info.lines = prevLines;
    }

    /**
     * Reads back the atlas and the mask and reports coverage. Debug only — a
     * full-target readback stalls the GPU, so never call it per frame.
     *
     * This is the bisection that matters when tree shadows do not appear:
     * `atlasCoverage` 0 means the silhouette bake produced nothing, `maskCoverage`
     * 0 with a good atlas means the quads are not landing in the window, and both
     * non-zero means the fault is in the ground shader's lookup.
     */
    debugStats(renderer: THREE.WebGLRenderer): Record<string, number> {
        const out: Record<string, number> = { live: this._live };
        const scan = (target: THREE.WebGLRenderTarget, prefix: string) => {
            const w = target.width, h = target.height;
            const buf = new Uint8Array(w * h * 4);
            renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
            let nz = 0, max = 0;
            for (let i = 3; i < buf.length; i += 4) {
                if (buf[i] > 0) nz++;
                if (buf[i] > max) max = buf[i];
            }
            out[`${prefix}Coverage`] = Number((nz / (w * h)).toFixed(4));
            out[`${prefix}MaxAlpha`] = max;
            out[`${prefix}Size`] = w;
        };
        if (this._atlas) scan(this._atlas.target, 'atlas');
        scan(this._target, 'mask');
        return out;
    }

    /** Trees in the mask this frame, for the perf HUD. */
    get liveCount(): number { return this._live; }
}
