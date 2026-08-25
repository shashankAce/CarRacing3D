import * as THREE from 'three';
import { Scene, Node, AmbientLight3D, DirectionalLight3D } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import { GameState } from '../game/GameState';
import { InputController } from '../game/InputController';
import { PlayerCar } from '../game/PlayerCar';
import { FollowCamera } from '../game/FollowCamera';
import { RoadMarkers } from '../world/RoadMarkers';
import { TerrainStreamer } from '../world/TerrainStreamer';
import { RoadMesh } from '../world/RoadMesh';
import { Hud } from '../ui/Hud';

/**
 * GameScene — Phase 3: infinite scroll.
 *
 * Steering, the follow camera, the speed ramp, streamed terrain and the
 * streamed road ribbon are all live. Still to come: traffic (Phase 4) and the
 * real procedural terrain field, scatter and LOD (Phase 5/6) — the height
 * field's ambient hills are a cheap placeholder for now.
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
     * Fixed update order. Input is sampled before the car reads it, and the
     * scroll is advanced before anything positions itself against it — so
     * nothing in a frame is ever reading last frame's state.
     */
    update(dt: number): void {
        this._input.sample();
        this._state.update(dt);
        // The car's world Z is `travelled` — it always renders at z ≈ 0.
        this._car.update(dt, this._input.axis, this._state.scroll.travelled, this._state.speed);
        // World geometry follows the scroll before the camera reads the car, so
        // nothing is ever a frame behind what the player is looking at.
        this._terrain.update();
        this._road.update();
        this._markers.update();
        this._camera.update(dt, this._car, this._state.speedT);
        this._hud.update(this._state, this._input.hasSteered);
    }

    onUnload(): void {
        this._input?.detach();
    }
}
