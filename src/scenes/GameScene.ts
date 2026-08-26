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
import { ShadowDecals } from '../world/ShadowDecals';
import { ProjectedShadows } from '../world/ProjectedShadows';
import { TreeShadowMask } from '../world/TreeShadowMask';
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
    private _shadows: ShadowDecals;
    private _projected: ProjectedShadows;
    private _treeMask: TreeShadowMask | null = null;
    /** Kept from `onRendererReady` so the tree mask can be rendered each frame. */
    private _renderer: THREE.WebGLRenderer | null = null;
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
            // Shadow silhouettes are baked from the light's point of view, so
            // they need the renderer too, and must exist before the first frame.
            this._shadows.bake(renderer as THREE.WebGLRenderer);
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
        this._terrain.buildAllNow();
        this._road.update();
        // Built before the first scatter sync, since the scatter loop feeds it.
        this._shadows = new ShadowDecals(this);
        // Registered before the first scatter sync, which is what feeds it.
        this._scatter.setTreeShadowMask(this._treeMask);
        this._scatter.setShadowDecals(
            cfg.lighting.bakedShadows.enabled && cfg.lighting.bakedShadows.includeTrees
                ? this._shadows : null);
        this._syncScatter();

        this._markers = new RoadMarkers(this, this._state.scroll);
        this._traffic = new TrafficSystem(this);
        if (cfg.lighting.bakedShadows.enabled) {
            // Registration only records geometry; the silhouettes are
            // render-target renders, baked in `onRendererReady` above.
            this._traffic.registerShadows(this._shadows);
            this._car.registerShadow(this._shadows);
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
            // Vehicles DO take the mask, but with `maskLift` — the lookup is
            // unprojected along the light first, so a raised or vertical surface
            // reads the ground point its light ray actually came over rather
            // than the one beneath it.
            for (const material of this._traffic.receiverMaterials) {
                this._projected.attach(material, { groundMask: true, maskLift: true });
            }
            // The car receives everything EXCEPT itself. With no depth test its
            // own silhouette would darken its whole down-light half on top of
            // what N.L already does, which reads as a smear rather than as
            // self-shadowing.
            for (const material of this._car.receiverMaterials) {
                this._projected.attach(material, {
                    skip: this._car.projectedHandle,
                    groundMask: true,
                    maskLift: true,
                });
            }
        }
        this._hud = new Hud(this);
        this._gameOver = new GameOverPanel(this);
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
    }

    /**
     * Half-extent of the orthographic shadow camera, from the reach pair. Both
     * `_buildLights` and `_updateSun` need it and must agree, so it is derived
     * in one place.
     */
    private _shadowRadius(): number {
        const sh = cfg.lighting.shadows;
        return (sh.reachAhead + sh.reachBehind) * 0.5;
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
            const radius = this._shadowRadius();
            cam.left = -radius;
            cam.right = radius;
            cam.top = radius;
            cam.bottom = -radius;
            // The light has to sit OUTSIDE the box it is shadowing, or geometry
            // between it and `near` is clipped out of the depth pass and simply
            // stops casting. Cheap to check, silent and baffling if wrong.
            if (cfg.lighting.sunDistance <= radius) {
                console.warn(
                    `[shadows] sunDistance ${cfg.lighting.sunDistance} is inside the `
                    + `${radius.toFixed(0)}m shadow radius; casters near the light will drop out.`,
                );
            }
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
        // Box centre, derived so it spans reachBehind..reachAhead about the car
        // rather than sitting symmetrically and wasting half of itself behind.
        const sh = cfg.lighting.shadows;
        const focusZ = (sh.reachBehind - sh.reachAhead) * 0.5;

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
            // Decals are rebuilt each frame around the scatter sync, which is
            // what pushes the tree ones -- so begin() has to come first and
            // commit() after everything has contributed.
            this._shadows.begin();
            // Opened BEFORE the scatter sync, which is what pushes the trees.
            this._treeMask?.begin(this._car.position.x);
            // The car's own y is the road surface under it (the wheels rest on
            // the ground), which is the plane every vehicle's lifted lookup is
            // measured from.
            this._projected.setTreeMaskPlane(this._car.position.y);
            this._syncScatter();
            if (cfg.lighting.bakedShadows.enabled) {
                this._traffic.addShadows(this._shadows, travelled);
                this._car.addShadow(this._shadows, travelled);
            }
            this._shadows.commit();

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
