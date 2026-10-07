import * as THREE from 'three';
import { PosedShadowAtlas } from '../src/procedural/PosedShadowAtlas';
import { ProjectedShadows } from '../src/world/ProjectedShadows';
import { lightFrame } from '../src/procedural/shadowSilhouette';
import { gameConfig as cfg } from '../src/config/gameConfig';
import { resolveTimeOfDay } from '../src/config/timeOfDay';

const result = document.querySelector('#result')!;
try {
    resolveTimeOfDay();
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(2);
    renderer.setSize(256, 256);
    document.body.append(renderer.domElement);
    const frame = lightFrame(cfg.lighting.sunDirection);
    const geometry = new THREE.BoxGeometry(2, 1.4, 4).translate(0, .7, 0);
    const atlas = new PosedShadowAtlas([[geometry]], frame, 128, 6);
    const pose = { handle: 0, rotation: new THREE.Quaternion() };
    const data = new Uint8Array(atlas.atlas.target.width * atlas.atlas.target.height * 4);
    const failures: string[] = [];
    const coverages: number[] = [];
    const trafficPoses = Array.from({ length: 6 }, () => ({ handle: 0, rotation: new THREE.Quaternion() }));
    for (let i = 0; i < 40; i++) {
        pose.rotation.setFromEuler(new THREE.Euler(Math.sin(i * .2) * .2, .3 * Math.cos(i * .1), 0, 'YXZ'));
        trafficPoses[i % 6].rotation.copy(pose.rotation);
        atlas.update(renderer, trafficPoses);
        renderer.readRenderTargetPixels(atlas.atlas.target, 0, 0, atlas.atlas.target.width, atlas.atlas.target.height, data);
        let count = 0;
        for (let p = 3; p < data.length; p += 4) if (data[p] > 0) count++;
        coverages.push(count);
        if (!count) failures.push(`Empty capture at frame ${i}`);
        for (let slot = 0; slot < 6; slot++) {
            let cellCoverage = 0;
            const x = slot % atlas.atlas.cols * 128, y = Math.floor(slot / atlas.atlas.cols) * 128;
            for (let row = y; row < y + 128; row++) for (let col = x; col < x + 128; col++) {
                if (data[(row * atlas.atlas.target.width + col) * 4 + 3]) cellCoverage++;
            }
            if (!cellCoverage) failures.push(`Empty traffic cell ${slot} at frame ${i}`);
        }
        renderer.resetState();
    }
    // Exercise the real patched road shader, not just atlas metadata.
    const shadows = new ProjectedShadows();
    const handle = shadows.register(geometry);
    shadows.bake(renderer);
    const roadMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    shadows.attach(roadMaterial);
    const scene = new THREE.Scene();
    const road = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), roadMaterial);
    road.rotation.x = -Math.PI / 2;
    scene.add(road);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.copy(frame.S).multiplyScalar(20);
    scene.add(sun);
    const camera = new THREE.OrthographicCamera(-12, 12, 12, -12, .01, 100);
    camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0);
    const target = new THREE.WebGLRenderTarget(256, 256);
    const pixels = new Uint8Array(256 * 256 * 4);
    renderer.setRenderTarget(target); renderer.setClearColor(0xffffff, 1); renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    const baseline = Math.max(...pixels.filter((_v, i) => i % 4 === 0));
    if (!baseline) failures.push('Road baseline is black');
    renderer.setRenderTarget(null); renderer.resetState();
    const darkCounts: number[] = [];
    for (let i = 0; i < 40; i++) {
        pose.rotation.setFromEuler(new THREE.Euler(Math.sin(i * .2) * .1, .3 * Math.cos(i * .1), 0, 'YXZ'));
        shadows.begin(); shadows.add(handle, 0, 0, 0, pose.rotation, -1); shadows.commit();
        renderer.setRenderTarget(target); renderer.setClearColor(0xffffff, 1); renderer.clear();
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
        let count = 0;
        for (let p = 0; p < pixels.length; p += 4) if (pixels[p] < baseline * .7) count++;
        darkCounts.push(count);
        if (!count) failures.push(`No road shadow at frame ${i}`);
        if (count > 32768) failures.push(`Road unexpectedly dark at frame ${i}: ${count}`);
        renderer.setRenderTarget(null); renderer.resetState();
    }
    result.textContent = JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', baseline, sun: frame.S.toArray(), failures, coverages, darkCounts });
    document.title = failures.length ? 'FAIL shadow regression' : 'PASS shadow regression';
} catch (error) { result.textContent = `ERROR ${String(error)}\n${(error as Error).stack}`; }
