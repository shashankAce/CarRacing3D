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
import { DesertScatterStreamer } from '../world/DesertScatterStreamer';
import { RoadMesh } from '../world/RoadMesh';
import { ProjectedShadows } from '../world/ProjectedShadows';
import { TreeShadowMask } from '../world/TreeShadowMask';
import { TouchControls } from '../ui/TouchControls';
import { Hud } from '../ui/Hud';
import { PerfHud } from '../ui/PerfHud';
import { GameOverPanel } from '../ui/GameOverPanel';
import { CarSelectPanel } from '../ui/CarSelectPanel';
import { EnvironmentToggle } from '../ui/EnvironmentToggle';
import { FullscreenButton } from '../ui/FullscreenButton';
import { CollisionDebugDraw } from '../ui/CollisionDebugDraw';
import { SkyDome, effectiveHorizonColor } from '../procedural/sky/SkyDome';
import { CloudSprites } from '../procedural/sky/CloudSprites';
import { VehicleModels, type VehicleModelId } from '../assets/VehicleModels';
import {
    activeEnvironment,
    activeEnvironmentBlend,
    setEnvironmentPosition,
    toggleEnvironment,
    type EnvironmentId,
} from '../config/environment';

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
    private _projected: ProjectedShadows;
    private _treeMask: TreeShadowMask | null = null;
    /** Kept from `onRendererReady` so the tree mask can be rendered each frame. */
    private _renderer: THREE.WebGLRenderer | null = null;
    private _scatter: ScatterStreamer;
    private _desertScatter: DesertScatterStreamer;
    private _traffic: TrafficSystem;
    private _hud: Hud;
    private _gameOver: GameOverPanel;
    private _carSelect: CarSelectPanel;
    private _environmentToggle: EnvironmentToggle;
    private _fullscreenButton: FullscreenButton;
    private _collisionDebug: CollisionDebugDraw | null = null;
    private _vehicleModels: VehicleModels;
    private _vehiclesReady = false;
    private _selectingCar = true;
    private _discardSelectionTap = false;
    private _perf: PerfHud | null = null;
    private _sun: DirectionalLight3D;
    private _sky: SkyDome;
    private _clouds: CloudSprites;
    private _lastEnvironmentBlend = Number.NaN;

    onLoad(): void {
        // Idempotent — the engine config already ran this, but calling it here
        // keeps the scene correct even if that flag is ever dropped.
        this._initThree(THREE);
        const sys = this.threeSceneSystem;

        // Both derived from the dome's own horizon, so distant terrain fades
        // into exactly the colour the sky shows behind it at any sun angle.
        setEnvironmentPosition(0);
        const horizon = effectiveHorizonColor();
        sys.scene.background = horizon;
        // No wrapper for fog by design — it has no lifecycle to manage.
        sys.scene.fog = new THREE.FogExp2(horizon.getHex(), cfg.world.fogDensity);

        // The renderer is created lazily on the first frame, so this callback
        // is the only correct place to configure it.
        sys.onRendererReady = (renderer) => {
            // Distant trees are billboards carrying a baked image of their own
            // mesh. Baking needs a renderer, and the engine creates one lazily
            // on the first frame — this callback is the earliest point it
            // exists. Until then the far tier is invisible rather than
            // untextured.
            this._scatter.bakeImpostors(renderer as THREE.WebGLRenderer);
            // The silhouette atlas: one render per caster type, once, then the
            // receiver shaders sample it forever. Must exist before the first
            // frame or receivers read a null sampler.
            this._projected.bake(renderer as THREE.WebGLRenderer);
            this._treeMask?.bake(renderer as THREE.WebGLRenderer);
            // The red channel's metre scale is only known once the atlas has
            // measured the tallest caster.
            if (this._treeMask) this._projected.setTreeMaskHeightScale(this._treeMask.heightScale);
            this._renderer = renderer as THREE.WebGLRenderer;
        };

        this._sky = new SkyDome(sys.scene);
        this._clouds = new CloudSprites(sys.scene);

        this._buildLights();

        this._state = new GameState();
        this._controls = new TouchControls(this);
        this._controls.setEnabled(false);
        this._input = new InputController(this._controls);
        this._input.attach();

        // Created before every receiver and caster: `attach` patches a material
        // and `register` records geometry, so both need this to already exist.
        this._projected = new ProjectedShadows();
        if (cfg.lighting.treeShadows.enabled) {
            this._treeMask = new TreeShadowMask();
            this._projected.setTreeMask(this._treeMask.texture, this._treeMask.rect);
        }

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
        this._desertScatter = new DesertScatterStreamer(this, this._state.scroll);
        // Both pools stay live: their placement density cross-fades spatially
        // through each forest/desert transition.
        this._scatter.setVisible(true);
        this._desertScatter.setVisible(true);
        this._terrain.buildAllNow();
        this._road.update();
        // Registered before the first scatter sync, which is what feeds it.
        this._scatter.setTreeShadowMask(this._treeMask);
        this._desertScatter.setTreeShadowMask(this._treeMask);
        this._syncScatter();

        this._markers = new RoadMarkers(this, this._state.scroll);
        this._traffic = new TrafficSystem(this);
        this._traffic.deactivate();
        if (cfg.debug.collisionBox.enabled) {
            this._collisionDebug = new CollisionDebugDraw(this, sys.scene, this._car, this._traffic);
        }

        if (cfg.lighting.projectedShadows.enabled) {
            // Casters first: `register` assigns the handles the receiver
            // patches below refer to, and the atlas cell order follows them.
            this._car.registerProjected(this._projected);
            this._traffic.registerProjected(this._projected);

            // Receivers. Every lit material that should catch a shadow gets the
            // same patch — that is the whole point of doing this in the shader
            // rather than with quads on the ground: the ground is not special.
            // GROUND receivers also sample the tree mask. The road markers are
            // instanced, which is the case the patch has to handle explicitly —
            // they were the one surface visibly missing its shadow.
            this._projected.attach(this._terrain.material, { groundMask: true });
            this._projected.attach(this._road.material, { groundMask: true });
            for (const material of this._markers.materials) {
                this._projected.attach(material, { groundMask: true });
            }
            // Vehicle receivers (traffic and the car) are NOT attached here —
            // their materials don't exist yet. Both are FBX-derived and created
            // asynchronously (`_attachTrafficMaterials`/`_attachPlayerMaterials`,
            // called from `_loadVehicleModels`/`_selectCar` once the real
            // materials exist). Attaching against the empty arrays this early
            // used to silently patch nothing — vehicles never received a
            // projected shadow at all, cast or received didn't matter, `attach`
            // simply had zero materials to iterate.
        }
        this._hud = new Hud(this);
        this._hud.setVisible(false);
        this._gameOver = new GameOverPanel(this);
        this._vehicleModels = new VehicleModels();
        this._carSelect = new CarSelectPanel(this, (id) => this._selectCar(id));
        this._environmentToggle = new EnvironmentToggle(this, activeEnvironment(), () => this._switchEnvironment());
        this._fullscreenButton = new FullscreenButton(this);
        this._input.ignoreTapTarget(this._fullscreenButton.node);
        if (cfg.debug.showPerf) {
            this._perf = new PerfHud(this, this._terrain, this._scatter, sys);
            // Debug bisection hook for the tree mask; see `debugStats`.
            (globalThis as Record<string, unknown>).__maskStats = () =>
                this._treeMask && this._renderer
                    ? this._treeMask.debugStats(this._renderer) : null;
            this._perf.shadowCounts = () => ({
                projected: this._projected.liveCount,
                treeMask: this._treeMask?.liveCount ?? 0,
            });
        }

        // Asset loading is intentionally asynchronous: the engine can render
        // its loading label immediately, while gameplay remains paused until a
        // player has selected a fully-loaded FBX model.
        void this._loadVehicleModels();
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

        this._updateSun();
    }

    /**
     * Keeps the sun positioned over the car.
     *
     * A directional light's illumination direction is fully determined by
     * `position - target.position`, independent of where that vector actually
     * sits in the world — nothing besides that direction is read from this
     * light elsewhere (real-time shadow maps, the one consumer that cared
     * about the light's absolute position and box framing, are gone). Kept
     * tracking the car anyway since it costs nothing and keeps the light's
     * gizmo sane if it's ever inspected.
     */
    private _updateSun(): void {
        const d = cfg.lighting.sunDirection;
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        const dist = cfg.lighting.sunDistance;
        const carX = this._car ? this._car.position.x : 0;
        const carY = this._car ? this._car.position.y : 0;
        const carZ = this._car ? this._car.position.z : 0;

        this._sun.target.position.set(carX, carY, carZ);
        this._sun.position.set(
            carX + (d.x / len) * dist,
            carY + (d.y / len) * dist,
            carZ + (d.z / len) * dist,
        );
    }

    /**
     * Fixed update order. Input is sampled before the car reads it, and the
     * scroll is advanced before anything positions itself against it — so
     * nothing in a frame is ever reading last frame's state.
     */
    update(dt: number): void {
        if (this._selectingCar) {
            this._camera.update(dt, this._car, 0);
            this._updateSun();
            this._sky.update(this._camera.position);
            this._clouds.update(dt, this._camera.position);
            return;
        }

        this._input.sample();
        if (this._discardSelectionTap) {
            this._input.consumeTap();
            this._discardSelectionTap = false;
        }

        if (this._state.isRunning) {
            this._state.update(dt, this._input.throttle);
            const travelled = this._state.scroll.travelled;
            setEnvironmentPosition(travelled);
            this._refreshEnvironmentSky();
            this._environmentToggle.setCurrent(activeEnvironment());
            // The car's world Z is `travelled` — it always renders at z ≈ 0.
            this._car.update(dt, this._input.axis, travelled, this._state.speed, this._state.speedT);
            this._traffic.update(dt, travelled, this._state.speedT, this._car.position.x);

            // Collision AFTER both have moved this frame, so neither is tested
            // against the other's previous position.
            const hit = findCollision(this._car, this._traffic);
            if (hit) this._endRun(cfg.hud.gameOverText);
            // Fuel is checked after the collision, so a crash on the last drop
            // of fuel reports as a crash rather than as an empty tank.
            else if (!this._state.isRunning) this._endRun(cfg.hud.outOfFuelText);

            // World geometry follows the scroll before the camera reads the car,
            // so nothing is ever a frame behind what the player is looking at.
            this._terrain.update();
            this._road.update();
            // Opened BEFORE the scatter sync, which is what pushes the trees.
            this._treeMask?.begin(this._car.position.x, travelled);
            // The car's own y is the road surface under it (the wheels rest on
            // the ground), which is the plane every vehicle's lifted lookup is
            // measured from.
            this._projected.setTreeMaskPlane(this._car.position.y);
            this._syncScatter();

            // Projected shadows are pure uniform writes — no geometry, no
            // render target — so this is just "collect the casters, keep the
            // nearest few". Ordered after the car and traffic have moved.
            if (cfg.lighting.projectedShadows.enabled) {
                this._projected.begin();
                this._car.addProjected(this._projected);
                this._traffic.addProjected(this._projected);
                this._projected.commit();
            }
            // The mask window follows the car and is filled by `_syncScatter`
            // above, so `commit` closes it here. The RENDER has to wait for the
            // renderer, which the engine only hands over in `onRendererReady` —
            // see `_renderTreeMask`.
            this._treeMask?.commit();
            // Rendered here rather than in a draw callback because the engine
            // renders the scene straight after `update`, and the ground
            // materials sample this mask in that same frame.
            if (this._renderer) this._treeMask?.render(this._renderer);
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
        this._collisionDebug?.update();
        this._perf?.update(dt);
    }

    /**
     * Trees follow the terrain's live chunk set rather than keeping their own
     * window, so a tree can never be left standing on ground that's been
     * recycled.
     */
    private _syncScatter(): void {
        const keys = this._terrain.liveChunkKeys();
        this._scatter.update(keys, TerrainStreamer.decodeKey);
        this._desertScatter.update(keys, TerrainStreamer.decodeKey);
    }

    /** Swaps the complete visual biome while preserving the current run state. */
    private _switchEnvironment(): EnvironmentId {
        const id = toggleEnvironment();
        this._discardSelectionTap = true;

        // The manual button jumps the cycle anchor for art/debug inspection.
        // Terrain colour and sand ripples are baked, so resident chunks follow it.
        this._terrain.refreshAllNow();
        this._scatter.reset();
        this._desertScatter.reset();
        this._syncScatter();

        this._refreshEnvironmentSky(true);
        return id;
    }

    /** Smoothly follows the biome mix under the player without rebuilding the dome. */
    private _refreshEnvironmentSky(force = false): void {
        const blend = activeEnvironmentBlend();
        // Fog derivation samples the forward sky arc. Updating every half-percent
        // is visually continuous while avoiding that CPU work on every frame.
        if (!force && Math.abs(blend - this._lastEnvironmentBlend) < 0.005) return;

        this._lastEnvironmentBlend = blend;
        this._sky.refreshEnvironment(blend);
        const horizon = effectiveHorizonColor(blend);
        this.threeSceneSystem.scene.background = horizon;
        const fog = this.threeSceneSystem.scene.fog;
        if (fog instanceof THREE.FogExp2) fog.color.copy(horizon);
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
        setEnvironmentPosition(this._state.scroll.travelled);
        this._refreshEnvironmentSky(true);
        this._environmentToggle.setCurrent(activeEnvironment());
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
        this._desertScatter.reset();
        this._syncScatter();
        this._markers.update();
        this._camera.snapTo(this._car);
    }

    /** Load all static model templates once, then allocate every traffic clone up front. */
    private async _loadVehicleModels(): Promise<void> {
        try {
            await this._vehicleModels.load();
            this._traffic.attachModels(this._vehicleModels);
            this._traffic.refreshProjectedGeometry(this._projected);
            this._projected.rebake();
            this._attachTrafficMaterials();
            this._vehiclesReady = true;
            this._carSelect.show();
        } catch (error) {
            console.error('[vehicles] Failed to load the vehicle catalog.', error);
        }
    }

    private _selectCar(id: VehicleModelId): void {
        if (!this._vehiclesReady || !this._selectingCar) return;

        this._state.setVehicleSpeedProfile(this._vehicleModels.spec(id).speed);
        this._car.setVisual(this._vehicleModels.create(id));
        this._car.refreshProjectedGeometry(this._projected);
        this._projected.rebake();
        this._attachPlayerMaterials();
        this._carSelect.hide();
        this._selectingCar = false;
        this._discardSelectionTap = true;
        this._controls.setEnabled(true);
        this._hud.setVisible(true);
        // The selection tap is also seen by InputController's global listener;
        // consume it so it cannot trigger an accidental restart later.
        this._restart();
    }

    private _attachTrafficMaterials(): void {
        if (!cfg.lighting.projectedShadows.enabled) return;
        const byType = this._traffic.receiverMaterialsByType;
        for (let type = 0; type < byType.length; type++) {
            for (const material of byType[type]) {
                this._projected.attach(material, {
                    // One atlas cell is shared by each traffic type. Skipping
                    // that cell avoids a car darkening itself; the small trade
                    // off is that two same-type cars do not shadow each other.
                    skip: this._traffic.projectedHandle(type),
                    groundMask: true,
                    maskLift: true,
                });
            }
        }
    }

    private _attachPlayerMaterials(): void {
        if (!cfg.lighting.projectedShadows.enabled) return;
        for (const material of this._car.receiverMaterials) {
            this._projected.attach(material, {
                skip: this._car.projectedHandle,
                groundMask: true,
                maskLift: true,
            });
        }
    }

    onUnload(): void {
        this._input?.detach();
        this._fullscreenButton?.detach();
        this._collisionDebug?.dispose();
    }
}
