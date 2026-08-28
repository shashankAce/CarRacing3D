import { ColorRect, Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

export type LoadingStage = 'assets' | 'compile' | 'world' | 'shadows';

/** Full-screen startup overlay driven only by real loading milestones. */
export class LoadingScreen {

    private _backdrop: Node;
    private _track: Node;
    private _fill: Node;
    private _title: Label;
    private _status: Label;
    private _percent: Label;
    private _visible = true;

    constructor(scene: Scene) {
        const c = cfg.loading;
        const cx = cfg.design.width / 2;
        const cy = cfg.design.height / 2;

        this._backdrop = new Node(cx, cy);
        this._backdrop.width = cfg.design.width;
        this._backdrop.height = cfg.design.height;
        this._backdrop.addComponent(ColorRect).color = c.backdropColor;
        scene.addChild(this._backdrop);

        this._title = this._makeLabel(scene, cx, c.titleY, c.titleFontSize, c.titleColor);
        this._title.text = c.title;
        this._status = this._makeLabel(scene, cx, c.statusY, c.statusFontSize, c.statusColor);
        this._percent = this._makeLabel(scene, cx, c.percentY, c.percentFontSize, c.percentColor);

        this._track = new Node(cx, c.barY);
        this._track.width = c.barWidth;
        this._track.height = c.barHeight;
        this._track.addComponent(ColorRect).color = c.trackColor;
        scene.addChild(this._track);

        // Keep the fill's left edge aligned with the track while its width
        // changes; the default centre anchor would expand in both directions.
        this._fill = new Node(cx - c.barWidth / 2, c.barY);
        this._fill.anchorX = 0;
        this._fill.height = c.barHeight;
        this._fill.addComponent(ColorRect).color = c.fillColor;
        scene.addChild(this._fill);

        this.setProgress('assets', 0, 0);
    }

    setProgress(stage: LoadingStage, stageProgress: number, overallProgress: number): void {
        const c = cfg.loading;
        const status = c.stages[stage];
        const total = Math.min(1, Math.max(0, overallProgress));
        this._status.text = status;
        this._percent.text = `${Math.round(total * 100)}%`;
        this._fill.width = c.barWidth * total;

        // Stage-local completion is intentionally not shown as a fake counter:
        // the wide bar represents the real overall startup work instead.
        void stageProgress;
    }

    showError(): void {
        this._status.text = cfg.loading.errorText;
        this._percent.text = '';
    }

    hide(): void {
        if (!this._visible) return;
        this._visible = false;
        this._backdrop.active = false;
        this._track.active = false;
        this._fill.active = false;
        this._title.node.active = false;
        this._status.node.active = false;
        this._percent.node.active = false;
    }

    private _makeLabel(scene: Scene, x: number, y: number, fontSize: number, color: string): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.fontSize = fontSize;
        label.color = color;
        label.textAlign = Label.TextAlign.CENTER;
        scene.addChild(node);
        return label;
    }
}
