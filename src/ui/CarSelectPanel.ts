import { Input, Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { VehicleModelId } from '../assets/VehicleModels';

interface Choice {
    node: Node;
}

/** A config-driven pre-race screen for selecting the player's FBX vehicle. */
export class CarSelectPanel {

    private _title: Label;
    private _hint: Label;
    private _titleNode: Node;
    private _hintNode: Node;
    private _choices: Choice[] = [];
    private _visible = false;

    constructor(scene: Scene, private readonly _onSelect: (id: VehicleModelId) => void) {
        const c = cfg.carSelect;
        const cx = cfg.design.width / 2;

        this._titleNode = new Node(cx, c.titleY);
        this._title = this._titleNode.addComponent(Label);
        this._title.fontSize = c.titleFontSize;
        this._title.color = c.titleColor;
        scene.addChild(this._titleNode);

        this._hintNode = new Node(cx, c.hintY);
        this._hint = this._hintNode.addComponent(Label);
        this._hint.fontSize = c.hintFontSize;
        this._hint.color = c.hintColor;
        scene.addChild(this._hintNode);

        cfg.vehicles.models.forEach((model, index) => {
            const y = c.firstChoiceY - index * c.choiceGap;
            const node = new Node(cx - c.choiceWidth / 2, y - c.choiceHeight / 2);
            node.width = c.choiceWidth;
            node.height = c.choiceHeight;
            node.on(Input.POINTER_DOWN, () => {
                if (this._visible) this._onSelect(model.id);
            }, this);

            const labelNode = new Node(c.choiceWidth / 2, c.choiceHeight / 2);
            const label = labelNode.addComponent(Label);
            label.fontSize = c.choiceFontSize;
            label.color = c.choiceColor;
            label.text = model.label;
            node.addChild(labelNode);
            scene.addChild(node);
            this._choices.push({ node });
        });

        this.setLoading();
    }

    setLoading(): void {
        this._visible = false;
        this._title.text = cfg.carSelect.loadingText;
        this._hint.text = '';
        this._titleNode.active = true;
        this._hintNode.active = false;
        for (const choice of this._choices) choice.node.active = false;
    }

    show(): void {
        this._visible = true;
        this._title.text = cfg.carSelect.title;
        this._hint.text = cfg.carSelect.hint;
        this._titleNode.active = true;
        this._hintNode.active = true;
        for (const choice of this._choices) choice.node.active = true;
    }

    hide(): void {
        this._visible = false;
        this._titleNode.active = false;
        this._hintNode.active = false;
        for (const choice of this._choices) choice.node.active = false;
    }
}
