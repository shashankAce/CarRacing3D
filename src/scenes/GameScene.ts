import * as THREE from 'three';
import { Scene, Node, AmbientLight3D, DirectionalLight3D } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { GameState } from '../game/GameState';
import { TrafficSystem } from '../game/TrafficSystem';
import { findCollision, scoreFor } from '../game/Collision';
import { InputController } from '../game/InputController';
import { PlayerCar } from '../game/PlayerCar';
import { FollowCamera } from '../game/FollowCamera';
import { RoadMarkers } from '../world/RoadMarkers';
import { TerrainStreamer } from '../world/TerrainStreamer';
import { RoadMesh } from '../world/RoadMesh';
import { Hud } from '../ui/Hud';
import { PerfHud } from '../ui/PerfHud';
import { GameOverPanel } from '../ui/GameOverPanel';

/**
 * GameScene — Phase 4: traffic and the game loop.
 *
 * Steering, the follow camera, the speed ramp, streamed terrain, the streamed
 * road ribbon, traffic, collision and the crash/restart loop are all live. Still
 * to come: the real procedural terrain field, scatter and LOD (Phase 5/6) — the
 * height field's ambient hills are a cheap placeholder for now.
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
    private _terrain: TerrainStreamer;
    private _road: RoadMesh;
    private _traffic: TrafficSystem;
    private _hud: Hud;
    private _gameOver: GameOverPanel;
    private _perf: PerfHud | null = null;

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

        this._state = new GameState();
        this._input = new InputController();
        this._input.attach();

        this._car = new PlayerCar(this);
        this._camera = new FollowCamera(this);
        this._camera.snapTo(this._car);

        // The streamers own plain THREE meshes rather than wrapper components:
        // they're created once, recycled forever, and never enter or leave the
        // scene, so there's no Node lifecycle for a wrapper to manage.
        this._terrain = new TerrainStreamer(sys.scene, this._state.scroll);
        this._road = new RoadMesh(sys.scene, this._state.scroll);
        // The player must never watch the world assemble itself, so the opening
        // window is built in full before the first frame rather than one chunk
        // at a time.
        this._terrain.buildAllNow();
        this._road.update();

        this._markers = new RoadMarkers(this, this._state.scroll);
        this._traffic = new TrafficSystem(this);
        this._hud = new Hud(this);
        this._gameOver = new GameOverPanel(this);
        if (cfg.debug.showPerf) this._perf = new PerfHud(this, this._terrain, sys);
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
     * Fixed update order. Input is sampled before the car reads it, and the
     * scroll is advanced before anything positions itself against it — so
     * nothing in a frame is ever reading last frame's state.
     */
    update(dt: number): void {
        this._input.sample();

        if (this._state.isRunning) {
            this._state.update(dt);
            const travelled = this._state.scroll.travelled;
            // The car's world Z is `travelled` — it always renders at z ≈ 0.
            this._car.update(dt, this._input.axis, travelled, this._state.speed);
            this._traffic.update(dt, travelled, this._state.speedT);

            // Collision AFTER both have moved this frame, so neither is tested
            // against the other's previous position.
            const hit = findCollision(this._car, travelled, this._traffic);
            if (hit) this._crash();

            // World geometry follows the scroll before the camera reads the car,
            // so nothing is ever a frame behind what the player is looking at.
            this._terrain.update();
            this._road.update();
            this._markers.update();
        } else if (this._input.consumeTap()) {
            this._restart();
        }

        // The camera keeps easing after a crash — it settles rather than
        // freezing mid-motion, which reads far better than a hard stop.
        this._camera.update(dt, this._car, this._state.speedT);
        this._hud.update(this._state, this._input.hasSteered, this._traffic.cuts);
        this._perf?.update(dt);
    }

    private _crash(): void {
        this._state.crash();
        this._gameOver.show(
            this._state.distance,
            this._traffic.cuts,
            scoreFor(this._state.distance, this._traffic.cuts),
        );
        // The tap that follows is the restart, not a steering input.
        this._input.consumeTap();
    }

    private _restart(): void {
        this._gameOver.hide();
        this._state.reset();
        this._car.reset();
        this._traffic.reset();
        // A finger may still be down from the restart tap; without this the car
        // would immediately veer toward whichever half of the screen was pressed.
        this._input.clearHold();
        // Rebuild the world for the new run's position and re-seat the camera,
        // so the player never sees the opening chunks stream in.
        this._terrain.buildAllNow();
        this._road.update();
        this._markers.update();
        this._camera.snapTo(this._car);
    }

    onUnload(): void {
        this._input?.detach();
    }
}
