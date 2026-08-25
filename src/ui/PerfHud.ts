import { Node, Label, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { TerrainStreamer } from '../world/TerrainStreamer';

/**
 * PerfHud — on-screen performance counters, for reading real numbers off a real
 * device instead of extrapolating from a desktop benchmark.
 *
 * Deliberately reports the WORST cases alongside the averages. A mean frame time
 * hides exactly the thing that ruins an infinite runner: an occasional spike
 * when several chunks land at once. `peak` (rolling, recent) and `all` (since the
 * run started) are the numbers that matter.
 *
 * Note the engine's own `#fps` overlay counts draw calls for the 2D batch
 * renderer only — it reads 1, because all the 3D geometry goes through Three.js's
 * renderer, which keeps its own stats. The `draws`/`tris` line here is the real
 * scene cost.
 *
 * Off by default; `debug.showPerf` turns it on. Not something to ship.
 */
export class PerfHud {

    private _label: Label;
    private _streamer: TerrainStreamer;
    /** Lazily resolved — the THREE renderer doesn't exist until the first frame. */
    private _sys: { renderer: { info: { render: { calls: number; triangles: number } } } | null };

    private _frames = 0;
    private _elapsed = 0;
    private _worstFrameMs = 0;
    private _sinceRepaint = 0;
    private _lastBuildCount = 0;

    constructor(scene: Scene, streamer: TerrainStreamer, sys: any) {
        this._streamer = streamer;
        this._sys = sys;

        const node = new Node(cfg.design.width / 2, cfg.hud.perfY);
        this._label = node.addComponent(Label);
        this._label.fontSize = cfg.hud.perfFontSize;
        this._label.color = cfg.hud.perfColor;
        // Monospace so the columns don't jitter as digit widths change — a
        // counter that reflows every repaint is much harder to read.
        this._label.fontFamily = 'monospace';
        // `dynamic` bakes this label on its own canvas, synchronously. Without
        // it a label that changes text gets an async ImageBitmap bake off a
        // shared canvas, which is the wrong trade for a counter.
        this._label.dynamic = true;
        this._label.text = '';
        scene.addChild(node);
    }

    update(dt: number): void {
        const frameMs = dt * 1000;
        this._frames++;
        this._elapsed += dt;
        this._sinceRepaint += dt;
        if (frameMs > this._worstFrameMs) this._worstFrameMs = frameMs;

        // One sample window per repaint. Every frame would be unreadable, and
        // would make the counter itself a measurable cost.
        if (this._sinceRepaint < cfg.hud.perfRepaintInterval) return;

        const fps = this._frames / this._elapsed;
        const meanMs = (this._elapsed * 1000) / this._frames;
        const buildsPerSec = (this._streamer.buildCount - this._lastBuildCount) / this._elapsed;
        const info = this._sys.renderer?.info.render;
        const s = this._streamer;

        this._label.text =
            `FPS ${fps.toFixed(0)}  frame ${meanMs.toFixed(1)}ms  worst ${this._worstFrameMs.toFixed(1)}\n` +
            `build ${s.lastBuildMs.toFixed(2)}  peak ${s.peakBuildMs.toFixed(2)}  all ${s.allTimePeakBuildMs.toFixed(2)}ms\n` +
            `chunks ${s.residentChunks}  queue ${s.pendingBuilds}  ${buildsPerSec.toFixed(1)}/s\n` +
            `draws ${info?.calls ?? 0}  tris ${((info?.triangles ?? 0) / 1000).toFixed(1)}k`;

        this._lastBuildCount = s.buildCount;
        this._frames = 0;
        this._elapsed = 0;
        this._worstFrameMs = 0;
        this._sinceRepaint = 0;
        s.resetPeak();
    }
}
