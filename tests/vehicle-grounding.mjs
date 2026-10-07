import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { createServer } from 'vite';

const server = await createServer({
    configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom',
    plugins: [{
        name: 'headless-engine-types',
        resolveId(id) {
            if (id === 'noonengine' || id === 'noonengine/3d') return '\0headless-engine';
        },
        load(id) {
            if (id === '\0headless-engine') {
                return 'export class Node {} export class Scene {} export class Group3D {}';
            }
        },
    }],
});
// FBX geometry tests need no browser images or GPU.
const loadTexture = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
try {
    const { VehicleGrounding } = await server.ssrLoadModule('/src/game/VehicleGrounding.ts');
    const { PlayerCar } = await server.ssrLoadModule('/src/game/PlayerCar.ts');
    const { TrafficSystem } = await server.ssrLoadModule('/src/game/TrafficSystem.ts');
    const { gameConfig: cfg } = await server.ssrLoadModule('/src/config/gameConfig.ts');
    const { roadCenterX, roadHeadingAt, roadLevelAt } = await server.ssrLoadModule('/src/world/roadPath.ts');
    const { surfaceHeightAt } = await server.ssrLoadModule('/src/procedural/heightField.ts');
    const solver = new VehicleGrounding();
    const q = new THREE.Quaternion();
    const point = new THREE.Vector3();
    let worstGap = 0;
    for (const spec of cfg.vehicles.models) {
        const bytes = fs.readFileSync(spec.asset);
        const model = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
        model.rotation.y = spec.rotationY;
        model.scale.setScalar(spec.scale);
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const centre = bounds.getCenter(new THREE.Vector3());
        model.position.set(-centre.x, -bounds.min.y, -centre.z);
        model.updateMatrixWorld(true);
        const contacts = [];
        model.traverse(object => {
            if (object.isMesh && ['FL', 'FR', 'BL', 'BR'].includes(object.name)) {
                const box = new THREE.Box3().setFromObject(object);
                const contact = box.getCenter(new THREE.Vector3());
                contact.y = box.min.y;
                contacts.push(contact);
            }
        });
        assert.equal(contacts.length, 4, `${spec.id}: four measured tyre contacts`);
        // Exercise the real placement paths without creating a renderer.
        const player = Object.assign(Object.create(PlayerCar.prototype), {
            _group: { object3D: new THREE.Group() },
            _width: bounds.max.x - bounds.min.x,
            _length: bounds.max.z - bounds.min.z,
            _tyreContacts: contacts, _grounding: new VehicleGrounding(),
            _x: roadCenterX(0), _yaw: 0, _spinWheels: () => {},
        });
        const traffic = Object.assign(Object.create(TrafficSystem.prototype), {
            _grounding: new VehicleGrounding(),
        });
        const vehicle = {
            group: { object3D: new THREE.Group() }, tyreContacts: contacts,
            laneF: 1, laneYaw: 0, worldZ: 0, signalDir: 0,
            indicator: new THREE.Group(),
        };
        function checkPlacement(object, worldZ, message) {
            const errors = contacts.map(contact => {
                point.copy(contact).applyQuaternion(object.quaternion);
                return object.position.y + point.y
                    - surfaceHeightAt(object.position.x + point.x, worldZ - point.z);
            });
            assert.ok(Math.min(...errors) > -1e-8, `${message}: penetration`);
            assert.ok(Math.max(...errors) < 0.015, `${message}: gap ${errors}`);
        }
        player.reset();
        checkPlacement(player._group.object3D, 0, `${spec.id}: reset`);
        for (const worldZ of [150, 310, 650, 1000, 1750]) {
            for (const axis of [-1, 0, 1]) {
                player.update(1 / 60, axis, worldZ, 75, 1);
                checkPlacement(player._group.object3D,
                    worldZ - player._group.object3D.position.z, `${spec.id}: player at ${worldZ}`);
                vehicle.worldZ = worldZ;
                vehicle.laneYaw = axis * 0.1;
                traffic._place(vehicle, worldZ - 20);
                checkPlacement(vehicle.group.object3D, worldZ,
                    `${spec.id}: traffic at ${worldZ}`);
            }
        }
        function gaps(x, z, yaw, heightAt) {
            solver.solve(contacts, x, z, yaw, heightAt);
            q.setFromEuler(new THREE.Euler(solver.pitch, yaw, solver.roll, 'YXZ'));
            return contacts.map(contact => {
                point.copy(contact).applyQuaternion(q);
                return solver.height + point.y - heightAt(x + point.x, z - point.z);
            });
        }
        for (const grade of [-0.3, -0.105, 0, 0.105, 0.3]) {
            for (const yaw of [-0.5, 0, 0.5]) {
                const plane = (x, z) => 2 + grade * z + 0.08 * x;
                const errors = gaps(1, 500, yaw, plane);
                assert.ok(Math.max(...errors) < 0.0001, `${spec.id}: plane contact ${errors}`);
                assert.ok(Math.min(...errors) > -1e-8, `${spec.id}: no penetration`);
            }
        }
        let modelGap = 0;
        // Go well beyond the car-selection screen and the flat-looking start.
        for (let z = 0; z <= 3000; z += 0.75) {
            for (const turn of [-0.35, 0, 0.35]) {
                const x = roadCenterX(z) + 2;
                const errors = gaps(x, z, roadHeadingAt(z) + turn, surfaceHeightAt);
                modelGap = Math.max(modelGap, ...errors);
                assert.ok(Math.min(...errors) > -1e-8, `${spec.id}: road penetration at ${z}`);
            }
        }
        // A rigid four-wheel chassis can bridge a small non-planar road kink.
        assert.ok(modelGap < 0.015, `${spec.id}: excessive gap ${modelGap}`);
        worstGap = Math.max(worstGap, modelGap);
        console.log(`${spec.label}: maximum tyre gap ${(modelGap * 1000).toFixed(2)} mm over 3 km`);
    }
    const step = cfg.roadSurface.bandLength / cfg.roadSurface.segmentsPerBand;
    for (const z of [-3.2, 0, 152.3, 705.7]) {
        const start = Math.floor(z / step) * step;
        const t = (z - start) / step;
        const expected = roadLevelAt(start) * (1 - t) + roadLevelAt(start + step) * t + cfg.roadSurface.lift;
        assert.ok(Math.abs(surfaceHeightAt(roadCenterX(z), z) - expected) < 1e-10);
    }
    console.log(`All grounding checks passed; worst gap ${(worstGap * 1000).toFixed(2)} mm.`);
} finally {
    THREE.TextureLoader.prototype.load = loadTexture;
    await server.close();
}
