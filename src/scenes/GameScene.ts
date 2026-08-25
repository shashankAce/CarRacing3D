import * as THREE from 'three';
import { Scene, Node, AmbientLight3D, DirectionalLight3D } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { GameState } from '../game/GameState';
import { InputController } from '../game/InputController';
import { PlayerCar } from '../game/PlayerCar';
import { FollowCamera } from '../game/FollowCamera';
import { RoadMarkers } from '../world/RoadMarkers';
import { Hud } from '../ui/Hud';

/**
 * GameScene — Phase 1: the core loop.
 *
 * Steering, the follow camera, the speed ramp and the scrolling world are all
 * live. Still placeholder: a flat infinite ground plane instead of streamed
 * terrain (Phase 2), and no traffic (Phase 3).
 *
 * The car never moves forward. It sits at the origin steering on X while the
 * world scrolls past — see WorldScroll and ARCHITECTURE.md §5.1.
 *
 * Engine rules that shape this file, all from ARCHITECTURE.md §3:
 *  - Everything is built in `onLoad()`. A node added in the constructor enters
 *    the tree before `threeSceneSystem` exists, and its 3D components silently
 *    no-op — no error, just nothing rendered.
 *  - `addChild()` comes before any transform set; `onEnable()` is what creates
 *    the underlying THREE object.
 *  - 3D wrappers don't follow the Node hierarchy — grouping is explicit.
 */
export class GameScene extends Scene {

    private _state: GameState;
    private _input: InputController;
    private _car: PlayerCar;
    private _camera: FollowCamera;
    private _markers: RoadMarkers;
    private _hud: Hud;

    onLoad(): void {
        // Idempotent — the engine config already ran this, but calling it here
        // keeps the scene correct even if that flag is ever dropped.
        this._initThree(THREE);
        const sys = this.threeSceneSystem;

        sys.scene.background = new THREE.Color(cfg.colors.sky);
        // No wrapper for fog by design — it has no lifecycle to manage.
        sys.scene.fog = new THREE.FogExp2(cfg.colors.fog, cfg.world.fogDensity);

        // The renderer is created lazily on the first frame, so this callback
        // is the only correct place to configure it.
        sys.onRendererReady = (renderer) => {
            renderer.shadowMap.enabled = cfg.render.shadows;
        };

        this._buildLights();
        this._buildGround(sys);

        this._state = new GameState();
        this._input = new InputController();
        this._input.attach();

        this._car = new PlayerCar(this);
        this._camera = new FollowCamera(this);
        this._camera.snapTo(this._car);
        this._markers = new RoadMarkers(this, this._state.scroll);
        this._hud = new Hud(this);
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
     * Placeholder flat world: a ground plane, a road surface and two painted
     * edge lines. All static and never toggled, so they're plain THREE meshes
     * added straight to the scene — a wrapper's whole purpose is add/remove/
     * dispose on the Node lifecycle, and there is none to manage here.
     *
     * These don't scroll, and don't need to: they're uniform along Z, so the
     * dashes and posts in RoadMarkers are what convey motion. Phase 2 replaces
     * all of it with streamed terrain chunks and a recycled road strip.
     */
    private _buildGround(sys: any): void {
        const size = cfg.world.groundSize;

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(size, size),
            new THREE.MeshStandardMaterial({ color: cfg.colors.ground, roughness: 0.95 }),
        );
        ground.rotation.x = -Math.PI / 2;
        sys.scene.add(ground);

        // Lifted a hair above the ground rather than sharing its exact Y —
        // coplanar surfaces z-fight.
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
     * Fixed update order. Input is sampled before the car reads it, and the
     * scroll is advanced before anything positions itself against it — so
     * nothing in a frame is ever reading last frame's state.
     */
    update(dt: number): void {
        this._input.sample();
        this._state.update(dt);
        this._car.update(dt, this._input.axis);
        this._markers.update();
        this._camera.update(dt, this._car, this._state.speedT);
        this._hud.update(this._state, this._input.hasSteered);
    }

    onUnload(): void {
        this._input?.detach();
    }
}
