import { gameConfig as cfg } from '../src/config/gameConfig';
import { ProjectedShadows } from '../src/world/ProjectedShadows';
import { GameScene } from '../src/scenes/GameScene';
import { surfaceHeightAt } from '../src/procedural/heightField';
import { lightFrame } from '../src/procedural/shadowSilhouette';
import * as THREE from 'three';

// These overrides apply only in this QA page, preserving the user's settings.
cfg.traffic.enabled = true;
cfg.carSelect.enabled = false;
cfg.vehicles.playerDefault = 'car';
cfg.camera.sideInspection.enabled = false;
cfg.fuel.capacity = 999;
const originalCommit = ProjectedShadows.prototype.commit;
const report = document.querySelector('#shadow-qa')!;
const gpuChecks = new URLSearchParams(location.search).has('gpu');
const followTraffic = new URLSearchParams(location.search).has('follow');
if (followTraffic) cfg.traffic.frozen = true;
let frames = 0, samples = 0, blank = 0, minimum = Infinity, maximum = 0;
const size = cfg.lighting.projectedShadows.textureSize;
const pixels = new Uint8Array(size * size * 4);
let worldZ = 0;
let receiverPixels = -1;
let trafficCells = '';
let missingReceiver = 0;
const receiverScene = new THREE.Scene();
const receiverCamera = new THREE.OrthographicCamera(-15, 15, 15, -15, .01, 100);
receiverCamera.up.set(0, 0, -1);
const receiverTarget = new THREE.WebGLRenderTarget(128, 128);
const withShadow = new Uint8Array(128 * 128 * 4), withoutShadow = new Uint8Array(128 * 128 * 4);
const receiverSun = new THREE.DirectionalLight(0xffffff, 3);
receiverScene.add(receiverSun, receiverSun.target, new THREE.AmbientLight(0xffffff, .5));
let receiverRoads: THREE.Mesh[] = [];
const originalUpdate = GameScene.prototype.update;
(GameScene.prototype as any)._endRun = () => {};
GameScene.prototype.update = function (dt: number) {
    worldZ = (this as any)._state?.scroll.travelled ?? 0;
    if (followTraffic && (this as any)._state?.isRunning) {
        for (const [i, vehicle] of (this as any)._traffic._pool.entries()) {
            vehicle.active = true;
            vehicle.type = vehicle.modelType;
            vehicle.worldZ = worldZ + 18 + i * 12;
            vehicle.group.object3D.visible = true;
        }
    }
    originalUpdate.call(this, dt);
    const game = this as any;
    if (!gpuChecks || !game._renderer || !frames || frames % 60) return;
    const roads = game._road._slots;
    if (!receiverRoads.length) {
        receiverRoads = roads.map((slot: any) => slot.mesh.clone());
        receiverScene.add(...receiverRoads);
    }
    receiverRoads.forEach((mesh, i) => { mesh.position.copy(roads[i].mesh.position); mesh.visible = roads[i].mesh.visible; });
    const position = game._car.position;
    receiverCamera.position.set(position.x + 4, position.y + 30, 8);
    receiverCamera.lookAt(position.x + 4, position.y, 8);
    receiverSun.position.copy(position).addScaledVector(new THREE.Vector3(
        cfg.lighting.sunDirection.x, cfg.lighting.sunDirection.y, cfg.lighting.sunDirection.z), 20);
    receiverSun.target.position.copy(position);
    const renderer = game._renderer;
    const target = renderer.getRenderTarget();
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const opacity = game._projected._uniforms.uProjShadowOpacity;
    const savedOpacity = opacity.value;
    renderer.setRenderTarget(receiverTarget); renderer.setClearColor(0, 0);
    renderer.clear(); renderer.render(receiverScene, receiverCamera);
    renderer.readRenderTargetPixels(receiverTarget, 0, 0, 128, 128, withShadow);
    opacity.value = 0;
    renderer.clear(); renderer.render(receiverScene, receiverCamera);
    renderer.readRenderTargetPixels(receiverTarget, 0, 0, 128, 128, withoutShadow);
    opacity.value = savedOpacity;
    receiverPixels = 0;
    for (let i = 0; i < withShadow.length; i += 4) {
        if (withoutShadow[i] - withShadow[i] > 1) receiverPixels++;
    }
    if (!receiverPixels) missingReceiver++;
    renderer.setRenderTarget(target);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.resetState();
};
ProjectedShadows.prototype.commit = function () {
    originalCommit.call(this);
    // Read the actual GPU atlas after the real gameplay update path.
    const state = this as any;
    if (!state._atlas || ++frames % 15) return;
    if (!gpuChecks) {
        report.textContent = `Traffic shadow QA (GPU readbacks disabled)\nFrames: ${frames}\nDistance: ${worldZ.toFixed(0)}\nLive shadows: ${this.liveCount}`;
        return;
    }
    state._renderer.readRenderTargetPixels(state._atlas.target, 0, 0, size, size, pixels);
    let coverage = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) coverage++;
    samples++; if (!coverage) blank++;
    minimum = Math.min(minimum, coverage); maximum = Math.max(maximum, coverage);
    trafficCells = state._pending.slice(0, cfg.lighting.projectedShadows.maxCasters).map((caster: any, slot: number) => {
        const data = new Uint8Array(size * size * 4);
        state._renderer.readRenderTargetPixels(state._atlas.target, slot % state._atlas.cols * size,
            Math.floor(slot / state._atlas.cols) * size, size, size, data);
        let covered = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) covered++;
        const frame = lightFrame(cfg.lighting.sunDirection);
        const shape = state._shape[slot];
        let hits = 0;
        for (let dx = -10; dx < 10; dx += .5) for (let dz = -20; dz < 20; dz += .5) {
            const rel = new THREE.Vector3(dx,
                surfaceHeightAt(caster.x + dx, worldZ - caster.z - dz) - caster.y, dz);
            const s = (rel.dot(frame.R) - shape.x) * shape.z;
            const t = (rel.dot(frame.U) - shape.y) * shape.w;
            if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
            const p = (Math.floor(t * size) * size + Math.floor(s * size)) * 4;
            const depth = -rel.dot(frame.S);
            const nearest = state._atlas.depthMin + (1 - data[p + 1] / 255) / state._atlas.depthInvSpan;
            if (data[p + 3] > 200 && depth + .015 >= nearest && depth < cfg.lighting.projectedShadows.fadeFar) hits++;
        }
        return `${slot}:z${caster.z.toFixed(0)}=${covered}/${hits}`;
    }).join(' ') + `; dropped: ${state._pending.slice(cfg.lighting.projectedShadows.maxCasters).map((p: any) => p.z.toFixed(0)).join(',')}`;
    const frame = lightFrame(cfg.lighting.sunDirection);
    const origin = state._origin[0], shape = state._shape[0];
    let accepted = 0, clipped = 0, silhouettes = 0;
    for (let x = origin.x - 12; x <= origin.x + 12; x += .2) {
        for (let z = origin.z - 18; z <= origin.z + 18; z += .2) {
            const y = surfaceHeightAt(x, worldZ - z);
            const rel = { x: x - origin.x, y: y - origin.y, z: z - origin.z };
            const r = rel.x * frame.R.x + rel.y * frame.R.y + rel.z * frame.R.z;
            const u = rel.x * frame.U.x + rel.y * frame.U.y + rel.z * frame.U.z;
            const s = (r - shape.x) * shape.z, t = (u - shape.y) * shape.w;
            if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
            const index = (Math.floor(t * size) * size + Math.floor(s * size)) * 4;
            if (pixels[index + 3] < 200) continue;
            silhouettes++;
            const d = -(rel.x * frame.S.x + rel.y * frame.S.y + rel.z * frame.S.z);
            const nearest = state._atlas.depthMin + (1 - pixels[index + 1] / 255) / state._atlas.depthInvSpan;
            if (d + .015 < nearest) clipped++;
            else if (d < cfg.lighting.projectedShadows.fadeFar) accepted++;
        }
    }
    report.textContent = `Actual gameplay GPU atlas\nFrames: ${frames} · Samples: ${samples}\nBlank captures: ${blank}\nCoverage: ${coverage} (${minimum}…${maximum})\nCells: ${trafficCells}\nReceiver samples: ${accepted} lit · ${clipped} clipped / ${silhouettes}\nGPU road shadow: ${receiverPixels} pixels · Missing: ${missingReceiver}\nDistance: ${worldZ.toFixed(0)}\nPitch: ${state._pending[0].rotation.x.toFixed(5)}`;
};
await import('../src/index');
