import { assetCache, Graphics, Input, Node, Scene, Sprite, Widget } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

const PAUSE_BUTTON_IMAGE_ALIAS = 'pausebtn';

/** Compact, always-reachable control that opens the pause modal. */
export class PauseButton {

    readonly node: Node;
    private readonly _icon: Sprite;
    private _iconLoaded = false;
    private readonly _surface: Graphics;

    constructor(scene: Scene, private readonly _onPause: () => void) {
        const c = cfg.overlays.pauseButton;
        this.node = new Node();
        this.node.name = 'PauseButton';
        this.node.width = c.size;
        this.node.height = c.size;
        scene.addChild(this.node);

        const surfaceNode = new Node();
        this._surface = surfaceNode.addComponent(Graphics);
        this._surface.setStroke(c.stroke, 2);
        this._surface.drawCircle(c.radius, c.background);
        this.node.addChild(surfaceNode);

        const widget = this.node.addComponent(Widget);
        widget.top = c.edgeMargin;
        widget.left = c.edgeMargin;
        widget.alignToWindow = true;

        const iconImage = new Node();
        this.node.addChild(iconImage);
        this._icon = iconImage.addComponent(Sprite);
        this.node.on(Input.POINTER_DOWN, this._press, this);
    }

    setVisible(visible: boolean): void {
        if (visible && !this._iconLoaded) {
            const texture = assetCache.getAsset(PAUSE_BUTTON_IMAGE_ALIAS);
            if (!texture) throw new Error(`Pause button image "${PAUSE_BUTTON_IMAGE_ALIAS}" is not loaded`);
            this._icon.texture = texture;
            this._iconLoaded = true;
        }
        this.node.active = visible;
    }

    private _press(): void {
        const c = cfg.overlays.pauseButton;
        this._icon.tint = c.pressed;
        this._onPause();
        this._icon.tint = '#ffffff';
    }
}
