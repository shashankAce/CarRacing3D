import { assetCache, ColorRect, Graphics, Node, Scene, Sprite } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

export type LoadingStage = 'assets' | 'compile' | 'world' | 'shadows';

const LOADING_BACKGROUND_ALIAS = 'loading-background';

/** Full-screen startup overlay driven only by real loading milestones. */
export class LoadingScreen {

    private _backdrop: Node;
    private _backgroundImage: Node;
    private _backgroundSprite: Sprite;
    private _track: Node;
    private _fill: Node;
    private _fillGraphic: Graphics;
    // private _status: Label;
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

        // This starts empty as a safe fallback. The image is assigned only
        // after AssetCache finishes loading it, so it also works in packed
        // playables where `res/` files are rewritten to data URIs.
        this._backgroundImage = new Node(cx, cy);
        this._backgroundImage.width = cfg.design.width;
        this._backgroundImage.height = cfg.design.width / c.backgroundImageAspectRatio;
        this._backgroundSprite = this._backgroundImage.addComponent(Sprite);
        scene.addChild(this._backgroundImage);

        // this._status = this._makeLabelTTF(scene, cx, c.statusY, c.statusFontSize, c.statusColor);
        this._track = new Node(cx, c.barY);
        const trackGraphic = this._track.addComponent(Graphics);
        trackGraphic.setNoFill()
            .setStroke(c.trackColor, c.barStrokeWidth)
            .drawRoundedRectangle(c.barWidth, c.barHeight, c.barHeight / 2);
        scene.addChild(this._track);

        // The fill starts inside the outline and grows from left to right.
        this._fill = new Node(cx - c.barWidth / 2 + c.barInset, c.barY);
        this._fill.anchorX = 0;
        this._fillGraphic = this._fill.addComponent(Graphics);
        this._fillGraphic.tessellate = true;
        scene.addChild(this._fill);

        this.setProgress('assets', 0, 0);
        void this._preloadAssets();
    }

    setProgress(stage: LoadingStage, stageProgress: number, overallProgress: number): void {
        const c = cfg.loading;
        const status = c.stages[stage];
        const total = Math.min(1, Math.max(0, overallProgress));
        // this._status.text = status;
        this._fill.active = total > 0;
        if (total > 0) {
            const fillHeight = c.barHeight - c.barInset * 2;
            this._fillGraphic.drawRoundedRectangle(
                (c.barWidth - c.barInset * 2) * total,
                fillHeight,
                fillHeight / 2,
                c.fillColor,
            );
        }

        // Stage-local completion is intentionally not shown as a fake counter:
        // the wide bar represents the real overall startup work instead.
        void stageProgress;
        void status;
    }

    showError(): void {
        // this._status.text = cfg.loading.errorText;
    }

    hide(): void {
        if (!this._visible) return;
        this._visible = false;
        this._backdrop.active = false;
        this._backgroundImage.active = false;
        this._track.active = false;
        this._fill.active = false;
        // this._status.node.active = false;
    }

    private async _preloadAssets(): Promise<void> {
        await assetCache.preloadAssets([
            // Keep the source literal in this preload entry: the playable packer
            // detects it and embeds the image in its single HTML output.
            { src: 'res/loading.jpg', type: 'image', alias: LOADING_BACKGROUND_ALIAS },
            // Kept explicit so production asset trimming retains the atlas page
            // referenced by the BMFont descriptor.
            { src: 'res/MonsterRacing.png', type: 'image' },
        ]);
        this._backgroundSprite.texture = assetCache.getAsset(LOADING_BACKGROUND_ALIAS);
        // The car-select title uses this font after the loading screen closes.
        await assetCache.preloadAssets([
            { src: 'res/MonsterRacing.json', type: 'bmfont', alias: cfg.loading.fontFamily },
        ]);
    }
}
