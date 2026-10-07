import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VehicleModels } from '../src/assets/VehicleModels';
import { VehicleGrounding } from '../src/game/VehicleGrounding';
import { ProjectedShadows } from '../src/world/ProjectedShadows';
import { gameConfig as cfg } from '../src/config/gameConfig';
import { resolveTimeOfDay } from '../src/config/timeOfDay';

resolveTimeOfDay();

const scene = new THREE.Scene();
scene.background = new THREE.Color('#151e29');
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.01, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xe3f1ff, 0x758295, 2.1));
const sun = new THREE.DirectionalLight(0xfff0dc, 3);
sun.position.copy(new THREE.Vector3(cfg.lighting.sunDirection.x,
    cfg.lighting.sunDirection.y, cfg.lighting.sunDirection.z).multiplyScalar(20));
scene.add(sun);

const ramp = new THREE.Group();
scene.add(ramp);
const road = new THREE.Mesh(new THREE.BoxGeometry(5.6, .12, 15),
    new THREE.MeshStandardMaterial({ color: 0x525f6b, roughness: .9 }));
road.position.y = -.06;
ramp.add(road);
for (const x of [-2.55, 2.55]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(.08, 15), new THREE.MeshBasicMaterial({ color: 0xc8d1d6 }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(x, .002, 0);
    ramp.add(line);
}
const grid = new THREE.GridHelper(15, 30, 0x8193a1, 0x667583);
grid.scale.x = 5.6 / 15;
grid.position.y = .003;
ramp.add(grid);

const chassis = new THREE.Group();
scene.add(chassis);
const guides = new THREE.Group();
scene.add(guides);
const models = new VehicleModels();
const solver = new VehicleGrounding();
const shadows = new ProjectedShadows();
shadows.attach(road.material);
const upright = new THREE.Quaternion();
let shadowHandle = -1;
const gradeInput = document.querySelector<HTMLInputElement>('#grade')!;
const travelInput = document.querySelector<HTMLInputElement>('#travel')!;
const status = document.querySelector<HTMLElement>('#stats')!;
let visual: ReturnType<VehicleModels['create']>;
let view = 'side';

function setView(next: string) {
    view = next;
    const target = new THREE.Vector3(0, .7, 0);
    controls.target.copy(target);
    if (view === 'side') camera.position.set(10, .9, 0);
    if (view === 'rear') camera.position.set(4.5, 2, 7);
    if (view === 'orbit') camera.position.set(7, 4, 6);
    camera.lookAt(target);
    for (const id of ['side', 'rear', 'orbit']) document.querySelector(`#${id}`)!.classList.toggle('active', id === view);
    controls.update();
}

function update() {
    const grade = Number(gradeInput.value) / 100;
    const distance = Number(travelInput.value);
    document.querySelector('#grade-value')!.textContent = `${Math.round(grade * 100)}%`;
    document.querySelector('#travel-value')!.textContent = `${distance.toFixed(2)} m`;
    ramp.rotation.x = Math.atan(grade);
    if (!visual) return;
    solver.solve(visual.tyreContacts, 0, 0, 0, (_x, z) => grade * z);
    chassis.position.set(0, solver.height, 0);
    chassis.rotation.set(solver.pitch, 0, solver.roll, 'YXZ');
    visual.spinWheels(distance);
    chassis.updateMatrixWorld(true);
    shadows.begin();
    shadows.add(shadowHandle, chassis.position.x, chassis.position.y, chassis.position.z,
        document.querySelector<HTMLInputElement>('#upright-shadow')!.checked ? upright : chassis.quaternion, -1);
    shadows.commit();
    guides.clear();
    const vertex = new THREE.Vector3();
    const instance = new THREE.Matrix4();
    const transform = new THREE.Matrix4();
    const normal = new THREE.Vector3(0, 1, grade).normalize();
    const gaps: { z: number; gap: number }[] = [];
    // Inspect the actual rendered instances, not the proxy contacts used by
    // the previous tests. Wheel rotation and nonuniform scaling matter here.
    visual.root.traverse(object => {
        if (!(object instanceof THREE.InstancedMesh)) return;
        const positions = object.geometry.getAttribute('position');
        for (let i = 0; i < object.count; i++) {
            object.getMatrixAt(i, instance);
            transform.multiplyMatrices(object.matrixWorld, instance);
            let gap = Infinity;
            const lowest = new THREE.Vector3();
            for (let j = 0; j < positions.count; j++) {
                vertex.fromBufferAttribute(positions, j).applyMatrix4(transform);
                const clearance = vertex.dot(normal);
                if (clearance < gap) { gap = clearance; lowest.copy(vertex); }
            }
            gaps.push({ z: lowest.z, gap });
            const dot = new THREE.Mesh(new THREE.SphereGeometry(.026, 12, 8), new THREE.MeshBasicMaterial({ color: gap < -.002 ? 0xff826b : 0x5ef2dd, depthTest: false }));
            dot.position.copy(lowest);
            dot.renderOrder = 5;
            guides.add(dot);
            const ground = lowest.clone().addScaledVector(normal, -gap);
            const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([lowest, ground]), new THREE.LineBasicMaterial({ color: 0xffcc70, depthTest: false }));
            guide.renderOrder = 5;
            guides.add(guide);
        }
    });
    const front = gaps.filter(v => v.z < 0).map(v => v.gap * 1000);
    const rear = gaps.filter(v => v.z >= 0).map(v => v.gap * 1000);
    const range = (values: number[]) => `${Math.min(...values).toFixed(1)} … ${Math.max(...values).toFixed(1)} mm`;
    status.textContent = `Road pitch    ${THREE.MathUtils.radToDeg(Math.atan(grade)).toFixed(2)}°\nCar pitch     ${THREE.MathUtils.radToDeg(solver.pitch).toFixed(2)}°\nFront tyres   ${range(front)}\nRear tyres    ${range(rear)}\nPositive = gap · Negative = penetration`;
    guides.visible = document.querySelector<HTMLInputElement>('#guides')!.checked;
}

gradeInput.addEventListener('input', update);
travelInput.addEventListener('input', update);
document.querySelector('#guides')!.addEventListener('change', update);
document.querySelector('#upright-shadow')!.addEventListener('change', update);
for (const id of ['side', 'rear', 'orbit']) document.querySelector(`#${id}`)!.addEventListener('click', () => setView(id));
for (const [id, grade] of [['uphill', 20], ['downhill', -20], ['flat', 0]] as const) {
    document.querySelector(`#${id}`)!.addEventListener('click', () => { gradeInput.value = String(grade); update(); });
}
window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});
setView('side');
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
try {
    await models.load();
    visual = models.create('car');
    chassis.add(visual.root);
    shadowHandle = shadows.register(visual.shadowGeometries);
    shadows.bake(renderer);
    document.querySelector('#loading')!.remove();
    update();
} catch (error) {
    document.querySelector('#loading')!.textContent = `Could not load coupe: ${String(error)}`;
}
