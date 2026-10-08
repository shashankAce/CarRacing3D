import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
const originalLoad = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
try {
    const { ProjectedShadows } = await server.ssrLoadModule('/src/world/ProjectedShadows.ts');
    const { lightFrame } = await server.ssrLoadModule('/src/procedural/shadowSilhouette.ts');
    const { gameConfig: cfg } = await server.ssrLoadModule('/src/config/gameConfig.ts');
    const spec = cfg.vehicles.models.find(v => v.id === 'car');
    const bytes = fs.readFileSync(spec.asset);
    const model = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    model.rotation.y = spec.rotationY;
    model.scale.setScalar(spec.scale);
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const centre = bounds.getCenter(new THREE.Vector3());
    model.position.set(-centre.x, -bounds.min.y, -centre.z);
    model.updateMatrixWorld(true);
    const geometries = [], tyrePoints = [];
    model.traverse(object => {
        if (!object.isMesh) return;
        geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
        if (['FL', 'FR', 'BL', 'BR'].includes(object.name)) {
            const tyre = new THREE.Box3().setFromObject(object);
            const point = tyre.getCenter(new THREE.Vector3());
            point.y = tyre.min.y;
            tyrePoints.push(point);
        }
    });
    assert.equal(tyrePoints.length, 4);
    // No GPU needed: exercise the real capture scenes, transforms, caching,
    // renderer-state restoration and generated receiver shaders.
    const renderer = {
        target: null, autoClear: true, scissorTest: false, alpha: 1,
        color: new THREE.Color(0x456789), viewport: new THREE.Vector4(3, 4, 800, 600),
        scissor: new THREE.Vector4(8, 9, 40, 50), draws: [],
        pixelRatio: 2, currentViewport: new THREE.Vector4(), currentScissor: new THREE.Vector4(),
        currentScissorTest: false, clears: [],
        getRenderTarget() { return this.target; },
        setRenderTarget(v) {
            this.target = v;
            this.currentViewport.copy(v ? v.viewport : this.viewport.clone().multiplyScalar(this.pixelRatio));
            this.currentScissor.copy(v ? v.scissor : this.scissor.clone().multiplyScalar(this.pixelRatio));
            this.currentScissorTest = v ? v.scissorTest : this.scissorTest;
        },
        resetState() { this.target = null; },
        getScissorTest() { return this.scissorTest; },
        setScissorTest(v) { this.scissorTest = v; this.currentScissorTest = v; },
        getClearAlpha() { return this.alpha; },
        getClearColor(v) { return v.copy(this.color); },
        setClearColor(v, alpha) { this.color.set(v); this.alpha = alpha; },
        getViewport(v) { return v.copy(this.viewport); },
        setViewport(...v) {
            v.length === 1 ? this.viewport.copy(v[0]) : this.viewport.set(...v);
            this.currentViewport.copy(this.viewport).multiplyScalar(this.pixelRatio);
        },
        getScissor(v) { return v.copy(this.scissor); },
        setScissor(...v) {
            v.length === 1 ? this.scissor.copy(v[0]) : this.scissor.set(...v);
            this.currentScissor.copy(this.scissor).multiplyScalar(this.pixelRatio);
        },
        clear() {
            assert.equal(this.currentScissorTest, true, 'each cell clear must stay clipped');
            assert.deepEqual(this.currentScissor.toArray(), this.currentViewport.toArray());
            assert.equal(this.currentViewport.z, cfg.lighting.projectedShadows.textureSize,
                'atlas cells use texture pixels, independent of screen DPR');
            this.clears.push(this.currentScissor.clone());
        },
        render(scene, camera) {
            scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
            assert.equal(scene.children.length, 1, 'one merged capture draw per car');
            this.draws.push(scene.children[0].quaternion.clone());
            assert.ok(scene.children[0].material.vertexShader.includes('modelMatrix * vec4(position, 1.0)'),
                'capture depth must include chassis rotation');
        },
    };
    const shadows = new ProjectedShadows();
    // Deliberately choose a handle that differs from its live slot.
    shadows.register(new THREE.BoxGeometry(1, 1, 1));
    const handle = shadows.register(geometries);
    shadows.bake(renderer);
    const material = new THREE.MeshStandardMaterial();
    shadows.attach(material, { skip: handle });
    const shader = {
        uniforms: {}, vertexShader: 'void main() {\n#include <project_vertex>\n}',
        fragmentShader: 'void main() {\n#include <lights_fragment_begin>\n}',
    };
    material.onBeforeCompile(shader);
    assert.ok(shader.fragmentShader.includes('dot(rel, uProjShadowR)'));
    assert.ok(shader.fragmentShader.includes('dot(rel, uProjShadowU)'));
    // The cell is a CPU-provided UV origin. Decoding the slot index inside the
    // shader with `mod(i, cols)` is what shipped broken: `mod(3.0, 3.0)` is 3.0
    // on ANGLE/D3D11, so one slot sampled past the atlas and lost its shadow.
    assert.ok(shader.fragmentShader.includes('uProjShadowCell[i]'), 'atlas cell follows live slot');
    assert.ok(!shader.fragmentShader.includes('mod(float(i)'), 'atlas cell is not decoded on the GPU');
    assert.ok(!shader.fragmentShader.includes('floor(float(i)'), 'atlas cell row is not decoded on the GPU');
    assert.ok(shader.fragmentShader.includes(`abs(origin.w - ${handle}.0)`), 'self skip follows model handle');
    const frame = lightFrame(cfg.lighting.sunDirection);
    let poses = 0;
    for (const pitch of [-.3, 0, .3]) for (const yaw of [-.4, 0, .4]) for (const roll of [-.08, .08]) {
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
        shadows.begin();
        shadows.add(handle, 2, 8, -10, rotation, -1);
        shadows.add(handle, -2, 5, -30, new THREE.Quaternion(), 1);
        shadows.commit();
        assert.ok(renderer.draws.at(-1).equals(rotation) || renderer.draws.at(-2).equals(rotation),
            'full pitch/yaw/roll reaches actual capture');
        const origin = shader.uniforms.uProjShadowOrigin.value[0];
        assert.deepEqual(origin.toArray(), [2, 8, -10, handle]);
        // Slot 1 must point at cell 1's own UV origin, computed on the CPU.
        const atlas = shadows._atlas;
        const cells = shader.uniforms.uProjShadowCell.value;
        assert.deepEqual(cells[0].toArray(), [0, 0]);
        assert.deepEqual(cells[1].toArray(), [1 / atlas.cols, 0]);
        const coarse = shader.uniforms.uProjShadowBounds.value[0];
        for (const tyrePoint of tyrePoints) {
            const posed = tyrePoint.clone().applyQuaternion(rotation);
            const ray = posed.clone().addScaledVector(frame.S, -2);
            assert.ok(Math.abs(posed.dot(frame.R) - ray.dot(frame.R)) < 1e-10);
            assert.ok(Math.abs(posed.dot(frame.U) - ray.dot(frame.U)) < 1e-10,
                'tyre contact and down-light shadow have identical receiver UVs');
            ray.add(new THREE.Vector3(2, 8, -10));
            assert.ok(ray.x >= coarse.x && ray.x <= coarse.z && ray.z >= coarse.y && ray.z <= coarse.w,
                'coarse bounds retain posed tyre shadow');
        }
        const draws = renderer.draws.length;
        shadows.begin();
        shadows.add(handle, 3, 9, -11, rotation, -1);
        shadows.add(handle, -2, 5, -30, new THREE.Quaternion(), 1);
        shadows.commit();
        assert.equal(renderer.draws.length, draws, 'translation needs no recapture');
        assert.equal(renderer.target, null);
        assert.equal(renderer.autoClear, true);
        assert.equal(renderer.scissorTest, false);
        assert.deepEqual(renderer.viewport.toArray(), [3, 4, 800, 600]);
        assert.deepEqual(renderer.scissor.toArray(), [8, 9, 40, 50]);
        assert.equal(renderer.color.getHex(), 0x456789);
        assert.equal(renderer.alpha, 1);
        poses++;
    }
    // Populate every atlas cell, then refresh only the player. The clear must
    // never touch the cached traffic cells, including on fractional DPR.
    for (const ratio of [1, 1.25, 1.5, 2, 3]) {
        renderer.pixelRatio = ratio;
        const rotations = Array.from({ length: cfg.lighting.projectedShadows.maxCasters }, (_, i) =>
            new THREE.Quaternion().setFromEuler(new THREE.Euler(.01 * ratio + i * .03, i * .1, 0, 'YXZ')));
        shadows.begin();
        rotations.forEach((rotation, i) => shadows.add(handle, i * 4, 0, -i * 10, rotation, i));
        shadows.commit();
        const atlas = shadows._posedAtlas.atlas;
        const captured = renderer.clears.slice(-rotations.length);
        captured.forEach((rect, i) => assert.deepEqual(rect.toArray(), [
            i % atlas.cols * cfg.lighting.projectedShadows.textureSize,
            Math.floor(i / atlas.cols) * cfg.lighting.projectedShadows.textureSize,
            cfg.lighting.projectedShadows.textureSize, cfg.lighting.projectedShadows.textureSize,
        ], `DPR ${ratio}: exact physical rectangle for cell ${i}`));
        const clearCount = renderer.clears.length;
        rotations[0].setFromEuler(new THREE.Euler(.2 + ratio * .01, 0, 0, 'YXZ'));
        shadows.begin();
        rotations.forEach((rotation, i) => shadows.add(handle, i * 4, 0, -i * 10, rotation, i));
        shadows.commit();
        assert.equal(renderer.clears.length, clearCount + 1, 'only changed cell cleared');
        assert.deepEqual(renderer.clears.at(-1).toArray(), [0, 0,
            cfg.lighting.projectedShadows.textureSize, cfg.lighting.projectedShadows.textureSize]);
    }
    shadows._posedAtlas.dispose();
    console.log(`Shadow checks passed: ${poses} coupe poses, all tyre rays, shared-model slots, translation cache, renderer state and isolated cell updates at five DPRs.`);
} finally {
    THREE.TextureLoader.prototype.load = originalLoad;
    await server.close();
}
