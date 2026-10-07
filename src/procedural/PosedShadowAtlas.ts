import * as THREE from 'three';
import { lightFrame, type ShadowAtlas } from './shadowSilhouette';

export interface ShadowPose {
    handle: number;
    rotation: THREE.Quaternion;
}

/** Vehicle silhouettes captured in their current pose under a fixed world sun. */
export class PosedShadowAtlas {
    readonly atlas: ShadowAtlas;
    private _scenes: THREE.Scene[] = [];
    private _handles: number[] = [];
    private _rotations: THREE.Quaternion[] = [];
    private _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 1000);
    private _material: THREE.ShaderMaterial;
    private _point = new THREE.Vector3();
    private _centre = new THREE.Vector3();
    private _clearColor = new THREE.Color();

    constructor(
        private _geometries: THREE.BufferGeometry[][],
        private _frame: ReturnType<typeof lightFrame>,
        private _cellSize: number,
        slots: number,
    ) {
        // Every part uses the same capture material. Merge position triangles
        // once so a changed vehicle pose costs one draw, including its tyres.
        this._geometries = _geometries.map(parts => {
            const count = parts.reduce((sum, part) => sum
                + (part.getIndex()?.count ?? part.getAttribute('position').count), 0);
            const positions = new Float32Array(count * 3);
            let offset = 0;
            for (const part of parts) {
                const source = part.getAttribute('position');
                const index = part.getIndex();
                const vertices = index?.count ?? source.count;
                for (let i = 0; i < vertices; i++) {
                    const vertex = index ? index.getX(i) : i;
                    positions[offset++] = source.getX(vertex);
                    positions[offset++] = source.getY(vertex);
                    positions[offset++] = source.getZ(vertex);
                }
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            return [geometry];
        });
        // An orientation-independent depth range keeps the encoding stable
        // when one cell changes; parked cells need no recapture.
        let radius = .01;
        for (const geometries of this._geometries) for (const geometry of geometries) {
            geometry.computeBoundingBox();
            const box = geometry.boundingBox!;
            for (let i = 0; i < 8; i++) {
                this._point.set(i & 1 ? box.max.x : box.min.x,
                    i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
                radius = Math.max(radius, this._point.length() + .05);
            }
        }
        const cols = Math.ceil(Math.sqrt(slots)), rows = Math.ceil(slots / cols);
        const target = new THREE.WebGLRenderTarget(cols * _cellSize, rows * _cellSize, {
            format: THREE.RGBAFormat, generateMipmaps: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        });
        this.atlas = {
            target, texture: target.texture, cols, rows,
            depthMin: -radius, depthInvSpan: 1 / (radius * 2), heightScale: radius,
            cells: Array.from({ length: slots }, (_, cell) =>
                ({ cell, rMin: 0, uMin: 0, invSpanR: 1, invSpanU: 1 })),
        };
        this._material = new THREE.ShaderMaterial({
            uniforms: {
                uSun: { value: _frame.S }, uDepthMin: { value: -radius },
                uDepthInvSpan: { value: this.atlas.depthInvSpan },
            },
            vertexShader: `
                uniform vec3 uSun;
                varying float vDepth;
                void main() {
                    vec4 posed = modelMatrix * vec4(position, 1.0);
                    vDepth = -dot(posed.xyz, uSun);
                    gl_Position = projectionMatrix * viewMatrix * posed;
                }`,
            fragmentShader: `
                uniform float uDepthMin, uDepthInvSpan;
                varying float vDepth;
                void main() {
                    float nearest = 1.0 - clamp((vDepth - uDepthMin) * uDepthInvSpan, 0.0, 1.0);
                    gl_FragColor = vec4(0.0, nearest, 0.0, 1.0);
                }`,
            side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
            blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        });
        for (let i = 0; i < slots; i++) {
            this._scenes.push(new THREE.Scene());
            this._handles.push(-1);
            this._rotations.push(new THREE.Quaternion());
        }
    }

    update(renderer: THREE.WebGLRenderer, poses: readonly ShadowPose[], count = poses.length): void {
        // Translation is handled by receiver uniforms. Only changes in caster
        // geometry or orientation require a draw; reuse the target and meshes.
        let needsDraw = false;
        for (let i = 0; i < count; i++) {
            if (this._handles[i] !== poses[i].handle
                || !this._rotations[i].equals(poses[i].rotation)) needsDraw = true;
        }
        if (!needsDraw) return;
        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        const previousAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this._clearColor);
        try {
            // The engine's 2D renderer shares this GL context and changes state
            // outside Three.js. Invalidate that cache before an offscreen pass.
            renderer.resetState();
            renderer.autoClear = false;
            renderer.setClearColor(0, 0);
            for (let i = 0; i < count; i++) {
                const pose = poses[i];
                if (this._handles[i] === pose.handle && this._rotations[i].equals(pose.rotation)) continue;
                const scene = this._scenes[i];
                if (this._handles[i] !== pose.handle) {
                    scene.clear();
                    for (const geometry of this._geometries[pose.handle]) {
                        scene.add(new THREE.Mesh(geometry, this._material));
                    }
                }
                for (const mesh of scene.children) mesh.quaternion.copy(pose.rotation);
                let rMin = Infinity, rMax = -Infinity, uMin = Infinity, uMax = -Infinity;
                for (const geometry of this._geometries[pose.handle]) {
                    const box = geometry.boundingBox!;
                    for (let j = 0; j < 8; j++) {
                        this._point.set(j & 1 ? box.max.x : box.min.x,
                            j & 2 ? box.max.y : box.min.y, j & 4 ? box.max.z : box.min.z)
                            .applyQuaternion(pose.rotation);
                        const r = this._point.dot(this._frame.R), u = this._point.dot(this._frame.U);
                        rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
                        uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
                    }
                }
                const padR = (rMax - rMin) * .04 + .001;
                const padU = (uMax - uMin) * .04 + .001;
                rMin -= padR; rMax += padR; uMin -= padU; uMax += padU;
                const cell = this.atlas.cells[i];
                cell.rMin = rMin; cell.uMin = uMin;
                cell.invSpanR = 1 / (rMax - rMin); cell.invSpanU = 1 / (uMax - uMin);
                const camera = this._camera;
                camera.left = (rMin - rMax) / 2; camera.right = -camera.left;
                camera.top = (uMax - uMin) / 2; camera.bottom = -camera.top;
                this._centre.copy(this._frame.R).multiplyScalar((rMin + rMax) / 2)
                    .addScaledVector(this._frame.U, (uMin + uMax) / 2);
                camera.position.copy(this._centre).addScaledVector(this._frame.S, 100);
                camera.up.copy(this._frame.U);
                camera.lookAt(this._centre);
                camera.updateProjectionMatrix();
                const x = i % this.atlas.cols * this._cellSize;
                const y = Math.floor(i / this.atlas.cols) * this._cellSize;
                // Target-owned rectangles are physical texture pixels. The
                // renderer setters scale by screen DPR, even offscreen, and
                // can write into another cell or entirely outside the atlas.
                const target = this.atlas.target;
                target.viewport.set(x, y, this._cellSize, this._cellSize);
                target.scissor.set(x, y, this._cellSize, this._cellSize);
                target.scissorTest = true;
                renderer.setRenderTarget(target);
                renderer.clear(true, true, false);
                renderer.render(scene, camera);
                this._handles[i] = pose.handle;
                this._rotations[i].copy(pose.rotation);
            }
        } finally {
            renderer.setRenderTarget(previousTarget);
            renderer.autoClear = previousAutoClear;
            renderer.setClearColor(this._clearColor, previousAlpha);
        }
    }

    dispose(): void {
        this.atlas.target.dispose();
        this._material.dispose();
        for (const geometries of this._geometries) for (const geometry of geometries) geometry.dispose();
    }
}
