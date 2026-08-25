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
import { ScatterStreamer } from '../world/ScatterStreamer';
import { RoadMesh } from '../world/RoadMesh';
import { TouchControls } from '../ui/TouchControls';
import { Hud } from '../ui/Hud';
import { PerfHud } from '../ui/PerfHud';
import { GameOverPanel } from '../ui/GameOverPanel';
import { SkyDome, effectiveHorizonColor } from '../procedural/sky/SkyDome';
import { CloudSprites } from '../procedural/sky/CloudSprites';

/**
 * GameScene — Phase 5: player throttle and fuel.
 *
 * Steering, the follow camera, the speed ramp, streamed terrain, the streamed
 * road ribbon, traffic, collision and the crash/restart loop are all live. Still
 * to come: the real procedural terrain field, scatter and LOD (Phase 6/6) — the
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
    private _controls: TouchControls;
    private _input: InputController;
    private _car: PlayerCar;
    private _camera: FollowCamera;
    private _markers: RoadMarkers;
    private _terrain: TerrainStreamer;
    private _road: RoadMesh;
    private _scatter: ScatterStreamer;
    private _traffic: TrafficSystem;
    private _hud: Hud;
    private _gameOver: GameOverPanel;
    private _perf: PerfHud | null = null;
    private _sun: DirectionalLight3D;
    private _sky: SkyDome;
    private _clouds: CloudSprites;

    onLoad(): void {
        // Idempotent — the engine config already ran this, but calling it here
        // keeps the scene correct even if that flag is ever dropped.
        this._initThree(THREE);
        const sys = this.threeSceneSystem;

        // Both derived from the dome's own horizon, so distant terrain fades
        // into exactly the colour the sky shows behind it at any sun angle.
        const horizon = effectiveHorizonColor();
        sys.scene.background = horizon;
        // No wrapper for fog by design — it has no lifecycle to manage.
        sys.scene.fog = new THREE.FogExp2(horizon.getHex(), cfg.world.fogDensity);

        // The renderer is created lazily on the first frame, so this callback
        // is the only correct place to configure it.
        sys.onRendererReady = (renderer) => {
            renderer.shadowMap.enabled = cfg.lighting.shadows.enabled;
            // Basic PCF rather than PCFSoft: soft shadows cost noticeably more
            // fill on a low-end phone, and at this camera distance the extra
            // edge quality is close to invisible. Swap if a reskin targets
            // better hardware.
            renderer.shadowMap.type = THREE.PCFShadowMap;

            // Distant trees are billboards carrying a baked image of their own
            // mesh. Baking needs a renderer, and the engine creates one lazily
            // on the first frame — this callback is the earliest point it
            // exists. Until then the far tier is invisible rather than
            // untextured.
            this._scatter.bakeImpostors(renderer as THREE.WebGLRenderer);
        };

        this._sky = new SkyDome(sys.scene);
        this._clouds = new CloudSprites(sys.scene);

        this._buildLights();

        this._state = new GameState();
        this._controls = new TouchControls(this);
        this._input = new InputController(this._controls);
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
        this._scatter = new ScatterStreamer(this, this._state.scroll);
        this._terrain.buildAllNow();
        this._road.update();
        this._syncScatter();

        this._markers = new RoadMarkers(this, this._state.scroll);
        this._traffic = new TrafficSystem(this);
        this._hud = new Hud(this);
        this._gameOver = new GameOverPanel(this);
        if (cfg.debug.showPerf) this._perf = new PerfHud(this, this._terrain, this._scatter, sys);
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
        this._sun = sun;

        const sh = cfg.lighting.shadows;
        if (sh.enabled) {
            // Shadow config isn't schema-exposed on the wrapper — this is the
            // documented raw-THREE escape hatch.
            const light = sun.light;
            light.castShadow = true;
            light.shadow.mapSize.set(sh.mapSize, sh.mapSize);
            // A directional light's shadow camera is orthographic; these bounds
            // are what the map's texels are spread across.
            const cam = light.shadow.camera;
            cam.left = -sh.frustumRadius;
            cam.right = sh.frustumRadius;
            cam.top = sh.frustumRadius;
            cam.bottom = -sh.frustumRadius;
            cam.near = sh.near;
            cam.far = sh.far;
            cam.updateProjectionMatrix();
            light.shadow.bias = sh.bias;
            light.shadow.normalBias = sh.normalBias;
        }
        this._updateSun();
    }

    /**
     * Keeps the sun — and therefore the shadow frustum — over the car.
     *
     * A directional light's shadow map covers only the box its orthographic
     * camera sees, so a fixed light would drop shadows entirely a few tens of
     * metres into an infinite run. The target leads the car slightly, since the
     * road ahead is what the player is looking at.
     */
    private _updateSun(): void {
        const d = cfg.lighting.sunDirection;
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        const dist = cfg.lighting.sunDistance;
        const carX = this._car ? this._car.position.x : 0;
        const carY = this._car ? this._car.position.y : 0;
        const focusZ = -cfg.lighting.shadows.frustumRadius * 0.4;

        this._sun.target.position.set(carX, carY, focusZ);
        this._sun.position.set(
            carX + (d.x / len) * dist,
            carY + (d.y / len) * dist,
            focusZ + (d.z / len) * dist,
        );
    }

    /**
     * Fixed update order. Input is sampled before the car reads it, and the
     * scroll is advanced before anything positions itself against it — so
     * nothing in a frame is ever reading last frame's state.
     */
    update(dt: number): void {
        this._input.sample();

        if (this._state.isRunning) {
            this._state.update(dt, this._input.throttle);
            const travelled = this._state.scroll.travelled;
            // The car's world Z is `travelled` — it always renders at z ≈ 0.
            this._car.update(dt, this._input.axis, travelled, this._state.speed);
            this._traffic.update(dt, travelled, this._state.speedT);

            // Collision AFTER both have moved this frame, so neither is tested
            // against the other's previous position.
            const hit = findCollision(this._car, travelled, this._traffic);
            if (hit) this._endRun(cfg.hud.gameOverText);
            // Fuel is checked after the collision, so a crash on the last drop
            // of fuel reports as a crash rather than as an empty tank.
            else if (!this._state.isRunning) this._endRun(cfg.hud.outOfFuelText);

            // World geometry follows the scroll before the camera reads the car,
            // so nothing is ever a frame behind what the player is looking at.
            this._terrain.update();
            this._road.update();
            this._syncScatter();
            this._markers.update();
        } else if (this._input.consumeTap()) {
            this._restart();
        }

        // The camera keeps easing after a crash — it settles rather than
        // freezing mid-motion, which reads far better than a hard stop.
        this._camera.update(dt, this._car, this._state.speedT);
        this._updateSun();
        this._sky.update(this._camera.position);
        this._clouds.update(dt, this._camera.position);
        this._hud.update(this._state, this._input.hasSteered, this._traffic.cuts);
        this._perf?.update(dt);
    }

    /**
     * Trees follow the terrain's live chunk set rather than keeping their own
     * window, so a tree can never be left standing on ground that's been
     * recycled.
     */
    private _syncScatter(): void {
        this._scatter.update(this._terrain.liveChunkKeys(), TerrainStreamer.decodeKey);
    }

    private _endRun(title: string): void {
        this._state.end();
        this._gameOver.show(
            title,
            this._state.distance,
            this._traffic.cuts,
            scoreFor(this._state.distance, this._traffic.cuts),
        );
        // The press that ended the run must not also count as the restart.
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
        this._scatter.reset();
        this._syncScatter();
        this._markers.update();
        this._camera.snapTo(this._car);
    }

    onUnload(): void {
        this._input?.detach();
    }
}
