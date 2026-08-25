import * as THREE from 'three';
import {
    Scene, Node, Group3D, Camera3D, AmbientLight3D, DirectionalLight3D, Label,
} from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/**
 * GameScene — Phase 0: the 3D boot.
 *
 * Establishes the render stack and the axis convention, and nothing else:
 * camera, lights, a flat placeholder ground, a placeholder road strip, and a
 * box car sitting at the origin. No movement, no input, no streaming — those
 * are Phase 1 and 2 (see ARCHITECTURE.md §7).
 *
 * Notes that are easy to get wrong here, all from ARCHITECTURE.md §3:
 *  - Everything is built in `onLoad()`. A node added in the constructor enters
 *    the tree before `threeSceneSystem` exists and its 3D components silently
 *    no-op.
 *  - `addChild()` comes before any transform set — `onEnable()` is what
 *    creates the underlying THREE object.
 *  - 3D wrappers do NOT follow the Node hierarchy; every wrapper's `object3D`
 *    is added to the THREE scene root. Grouping is explicit, via
 *    `group.object3D.add(...)`.
 *  - The 3D pass renders before the 2D pass, so the NoonEngine 2D node tree is
 *    automatically a HUD on top.
 */
export class GameScene extends Scene {

    private _car: Group3D;
    private _camera: Camera3D;

    onLoad(): void {
        // Idempotent — the engine config already ran this, but calling it
        // first makes this scene correct even if that flag is ever dropped.
        this._initThree(THREE);
        const sys = this.threeSceneSystem;

        sys.scene.background = new THREE.Color(cfg.colors.sky);
        // No wrapper for fog by design — nothing to manage in its lifecycle.
        sys.scene.fog = new THREE.FogExp2(cfg.colors.fog, cfg.world.fogDensity);

        // The renderer is created lazily on the first frame, so this callback
        // is the only correct place to configure it.
        sys.onRendererReady = (renderer) => {
            renderer.shadowMap.enabled = cfg.render.shadows;
        };

        this._buildLights();
        this._buildGround(sys);
        this._car = this._buildCar();
        this._camera = this._buildCamera();
        this._snapCameraToCar();
        this._buildHud();
    }

    private _buildLights(): void {
        const ambNode = new Node();
        const amb = ambNode.addComponent(AmbientLight3D);
        amb.color = cfg.lighting.ambientColor;
        amb.intensity = cfg.lighting.ambientIntensity;
        this.addChild(ambNode);

        const sunNode = new Node();
        const sun = sunNode.addComponent(DirectionalLight3D);
        sun.color = cfg.lighting.sunColor;
        sun.intensity = cfg.lighting.sunIntensity;
        this.addChild(sunNode);
        const p = cfg.lighting.sunPosition;
        sun.position.set(p.x, p.y, p.z);
        sun.target.position.set(0, 0, 0);
    }

    /**
     * Placeholder flat world — a ground plane plus a road strip so forward
     * (-Z) is visually unambiguous. Both are static and never toggled, so
     * they're plain THREE meshes added straight to the scene: a wrapper's
     * whole purpose is add/remove/dispose on the Node lifecycle, and there
     * is no lifecycle here to manage.
     *
     * Phase 2 replaces all of this with streamed terrain chunks + a recycled
     * road strip.
     */
    private _buildGround(sys: any): void {
        const size = cfg.world.groundSize;

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(size, size),
            new THREE.MeshStandardMaterial({ color: cfg.colors.ground, roughness: 0.95 }),
        );
        ground.rotation.x = -Math.PI / 2;
        sys.scene.add(ground);

        // Road, laid along Z. Lifted a hair above the ground plane rather than
        // sharing its exact Y — coplanar surfaces z-fight.
        const road = new THREE.Mesh(
            new THREE.PlaneGeometry(cfg.road.halfWidth * 2, size),
            new THREE.MeshStandardMaterial({ color: cfg.colors.road, roughness: 0.9 }),
        );
        road.rotation.x = -Math.PI / 2;
        road.position.y = 0.01;
        sys.scene.add(road);

        const lineMat = new THREE.MeshStandardMaterial({ color: cfg.colors.roadLine, roughness: 0.8 });
        for (const side of [-1, 1]) {
            const line = new THREE.Mesh(new THREE.PlaneGeometry(cfg.road.lineWidth, size), lineMat);
            line.rotation.x = -Math.PI / 2;
            line.position.set(side * (cfg.road.halfWidth - cfg.road.lineWidth), 0.02, 0);
            sys.scene.add(line);
        }
    }

    /**
     * The car: a Group3D holding placeholder boxes. It's a group rather than a
     * bare Mesh3D specifically so the later model swap is "empty the group,
     * add the loaded scene" and touches no gameplay code.
     */
    private _buildCar(): Group3D {
        const node = new Node();
        const group = node.addComponent(Group3D);
        this.addChild(node);

        const c = cfg.car;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(c.width, c.height, c.length),
            new THREE.MeshStandardMaterial({ color: cfg.colors.car.body, roughness: 0.5, metalness: 0.15 }),
        );
        body.position.y = c.height / 2;

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(c.width * c.cabinWidthFactor, c.cabinHeight, c.length * c.cabinLengthFactor),
            new THREE.MeshStandardMaterial({ color: cfg.colors.car.cabin, roughness: 0.35, metalness: 0.2 }),
        );
        // Biased toward the rear (+Z) so the silhouette reads as facing -Z.
        cabin.position.set(0, c.height + c.cabinHeight / 2, c.length * 0.1);

        group.object3D.add(body, cabin);
        group.position.set(0, 0, 0);
        return group;
    }

    private _buildCamera(): Camera3D {
        const node = new Node();
        const cam = node.addComponent(Camera3D);
        cam.fov = cfg.camera.fov;
        cam.near = cfg.camera.near;
        cam.far = cfg.camera.far;
        this.addChild(node);
        return cam;
    }

    /**
     * Places the camera at its rest offset behind the car with no damping.
     * Phase 1 replaces the call site with a per-frame exponentially damped
     * follow (ARCHITECTURE.md §5.6); the offset maths stays exactly this.
     */
    private _snapCameraToCar(): void {
        const car = this._car.position;
        const c = cfg.camera;
        this._camera.position.set(car.x, car.y + c.height, car.z + c.distance);
        this._camera.lookAt(car.x, car.y + c.lookHeight, car.z - c.lookAhead);
    }

    /** 2D HUD — same scene, same addChild, drawn over the 3D pass for free. */
    private _buildHud(): void {
        const node = new Node(cfg.design.width / 2, cfg.design.height - 60);
        const label = node.addComponent(Label);
        label.text = 'PHASE 0 — 3D BOOT';
        label.fontSize = 34;
        label.color = '#ffffff';
        this.addChild(node);
    }

    update(_dt: number): void { }
}
