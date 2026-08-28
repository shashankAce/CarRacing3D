import { Input, Label, Node, Scene, Widget, inputListener } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { EnvironmentId } from '../config/environment';

/** Compact always-available button for swapping forest and desert. */
export class EnvironmentToggle {
    readonly node: Node;
    private _label: Label;
    private _current: EnvironmentId;

    constructor(scene: Scene, current: EnvironmentId, onToggle: () => EnvironmentId) {
        const c = cfg.environmentToggle;
        const width = inputListener.engine?.display?.designWidth ?? cfg.design.width;

        this.node = new Node();
        this.node.width = c.width;
        this.node.height = c.height;
        scene.addChild(this.node);

        let widget = this.node.addComponent(Widget);
        widget.top = 25;
        widget.right = 100;

        this._label = this.node.addComponent(Label);
        this._label.fontSize = c.fontSize;
        this._label.color = c.color;

        this._current = current;
        this._refresh();
        this.node.on(Input.POINTER_DOWN, () => {
            this._label.color = c.pressedColor;
            this._current = onToggle();
            this._refresh();
        }, this);
    }

    private _refresh(): void {
        this._label.color = cfg.environmentToggle.color;
        this._label.text = `${cfg.environmentToggle.prefix}: ${cfg.environmentToggle.labels[this._current]}`;
    }

    /** Lets the automatic distance-based cycle keep the label in sync. */
    setCurrent(current: EnvironmentId): void {
        if (current === this._current) return;
        this._current = current;
        this._refresh();
    }
}
