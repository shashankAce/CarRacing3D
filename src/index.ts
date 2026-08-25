import * as THREE from 'three';
import { GameEngine, createPlatform, ResolutionPolicy, RendererType } from 'noonengine';
import { gameConfig as cfg } from './config/gameConfig';
import { GameScene } from './scenes/GameScene';
import { installFogCurve } from './procedural/fogCurve';
import { resolveTimeOfDay } from './config/timeOfDay';

/**
 * Entry point. See ARCHITECTURE.md for the design, the verified engine
 * constraints, and the phase plan. Currently at Phase 1 — 3D boot.
 */

// Host-platform wrapper. Never branch on `platform.name`; the one capability
// worth branching on is `platform.isAdCreative` (a creative needs a CTA
// button, a hosted game must not show one) — that lands in Phase 7.
// Reshapes THREE's FogExp2 exponent. Global ShaderChunk surgery, so it has to
// happen before any shader program is built — see procedural/fogCurve.ts.
installFogCurve();

// Turns the configured (or device-local) hour into sunDirection + ambient,
// which the sky, the derived fog and the shadow frustum all read. Must run
// BEFORE the scene is constructed, since GameScene derives fog from the sun.
resolveTimeOfDay();

const platform = createPlatform();
await platform.initialize();  // must be awaited BEFORE constructing GameEngine

const engine = new GameEngine({
    // 3D is WebGL-only — Canvas/WebGPU are guarded off with an explicit error.
    renderType: RendererType.WEBGL,
    enable3D: true,
    three: THREE,
    // Caps devicePixelRatio rather than following it. See ARCHITECTURE.md §2.4.
    pixelRatio: cfg.render.pixelRatioCap,
    resolutionScale: cfg.render.resolutionScale,
    showStats: true,
});

engine.setDesignResolution(cfg.design.width, cfg.design.height, ResolutionPolicy.FIXED_HEIGHT);
engine.runScene(new GameScene());
engine.start();

// Nothing to preload yet — the world is generated, not loaded. Once there is a
// real generation step (Phase 6), drive `platform.reportProgress()` from it and
// move this call to when the game is genuinely playable.
platform.notifyReady();
