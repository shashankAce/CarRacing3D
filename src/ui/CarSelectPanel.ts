import { ColorRect, Graphics, Input, Label, Node, Scene, Widget, inputListener } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { VehicleModelId } from '../assets/VehicleModels';

type VehicleSpec = typeof cfg.vehicles.models[number];

interface StatRow {
    fill: Node;
    value: Label;
    maximum: number;
    read: (spec: VehicleSpec) => number;
    format: (value: number) => string;
}

/** Showroom navigation and config-driven vehicle performance card. */
export class CarSelectPanel {

    private readonly _root = new Node();
    private readonly _name: Label;
    private readonly _description: Label;
    private readonly _stats: StatRow[] = [];
    private readonly _interactiveNodes: Node[] = [];
    private _index = 0;
    private _visible = false;
    private _dragPointerId: number | null = null;
    private _lastDragX = 0;

    constructor(
        scene: Scene,
        private readonly _onPreview: (id: VehicleModelId, direction: number) => boolean,
        private readonly _onDrive: (id: VehicleModelId) => void,
        private readonly _onRotate: (screenDeltaX: number) => void,
        private readonly _onDragState: (dragging: boolean) => void,
    ) {
        const c = cfg.carSelect;
        const cx = cfg.design.width / 2;
        this._root.name = 'CarShowroomUI';
        scene.addChild(this._root);

        const eyebrow = this._makeLabel(cx, c.eyebrowY, c.eyebrowFontSize, c.eyebrowColor);
        eyebrow.fontWeight = 700;
        eyebrow.text = c.eyebrow;

        const title = this._makeLabel(cx, c.titleY, c.titleFontSize, c.titleColor);
        title.fontWeight = 800;
        title.text = c.title;

        this._name = this._makeLabel(cx, c.carNameY, c.carNameFontSize, c.titleColor, true);
        this._name.fontWeight = 800;
        this._description = this._makeLabel(cx, c.descriptionY, c.descriptionFontSize, c.descriptionColor, true);

        this._makeDragZone();
        this._makeArrow(-1);
        this._makeArrow(1);

        const panelNode = new Node(cx, c.statsPanelY);
        const panel = panelNode.addComponent(Graphics);
        panel.tessellate = true;
        panel.drawRoundedRectangle(c.statsPanelWidth, c.statsPanelHeight, 24, c.statsPanelColor);
        this._root.addChild(panelNode);

        const statConfig = c.stats;
        this._stats.push(
            this._makeStatRow(0, statConfig.speedLabel, statConfig.maxSpeedKph,
                (spec) => spec.speed.max * 3.6, (value) => `${Math.round(value)} KM/H`),
            this._makeStatRow(1, statConfig.accelerationLabel, statConfig.maxAcceleration,
                (spec) => spec.speed.accelerate, (value) => `${value.toFixed(1)} M/S²`),
            this._makeStatRow(2, statConfig.brakingLabel, statConfig.maxBraking,
                (spec) => spec.speed.brake, (value) => `${value.toFixed(0)} M/S²`),
        );

        this._makeDriveButton();
        inputListener.on(Input.POINTER_MOVE, this._onDragMove, null, this);
        inputListener.on(Input.POINTER_UP, this._onDragRelease, null, this);
        inputListener.on(Input.POINTER_CANCEL, this._onDragRelease, null, this);
        // NoonEngine emits DRAG_END for both a normal release and a native
        // pointer-cancel. Listening here prevents mobile gestures from leaving
        // the showroom permanently stuck in its manual-rotation state.
        inputListener.on(Input.DRAG_END, this._onDragRelease, null, this);
        this.setLoading();
    }

    get interactiveNodes(): readonly Node[] { return this._interactiveNodes; }

    get selectedId(): VehicleModelId { return cfg.vehicles.models[this._index].id; }

    setLoading(): void {
        this._visible = false;
        this._root.active = false;
    }

    show(initialId: VehicleModelId = cfg.vehicles.playerDefault): void {
        const index = cfg.vehicles.models.findIndex((model) => model.id === initialId);
        this._index = index >= 0 ? index : 0;
        this._visible = true;
        this._root.active = true;
        this._refresh();
    }

    hide(): void {
        this._visible = false;
        if (this._dragPointerId !== null) this._onDragState(false);
        this._dragPointerId = null;
        this._root.active = false;
    }

    detach(): void {
        inputListener.off(Input.POINTER_MOVE, this._onDragMove, null);
        inputListener.off(Input.POINTER_UP, this._onDragRelease, null);
        inputListener.off(Input.POINTER_CANCEL, this._onDragRelease, null);
        inputListener.off(Input.DRAG_END, this._onDragRelease, null);
    }

    private _makeDragZone(): void {
        const c = cfg.carSelect.showroom.drag;
        const node = new Node(cfg.design.width / 2, c.centerY);
        node.name = 'ShowroomCarDragZone';
        node.width = c.width;
        node.height = c.height;
        node.on(Input.POINTER_DOWN, this._onDragStart, this);
        this._root.addChild(node);
        this._interactiveNodes.push(node);
    }

    private _onDragStart(e: any): void {
        if (!this._visible || this._dragPointerId !== null) return;
        this._dragPointerId = e.pointer.id;
        this._lastDragX = e.x;
        this._onDragState(true);
    }

    private _onDragMove(e: any): void {
        if (e.pointer.id !== this._dragPointerId) return;
        const deltaX = e.x - this._lastDragX;
        this._lastDragX = e.x;
        this._onRotate(deltaX);
    }

    private _onDragRelease(e: any): void {
        if (this._dragPointerId === null) return;
        if (e.pointer.id !== this._dragPointerId) return;
        this._dragPointerId = null;
        this._onDragState(false);
    }

    private _makeArrow(direction: -1 | 1): void {
        const c = cfg.carSelect;
        const node = new Node(0, c.arrowY);
        node.name = direction < 0 ? 'PreviousCarButton' : 'NextCarButton';
        node.width = c.arrowSize;
        node.height = c.arrowSize;
        const widget = node.addComponent(Widget);
        widget.alignToWindow = true;
        if (direction < 0) widget.left = c.arrowEdge;
        else widget.right = c.arrowEdge;

        const backgroundNode = new Node();
        const background = backgroundNode.addComponent(Graphics);
        background.tessellate = true;
        background.setStroke(c.arrowStroke, 3);
        background.drawCircle(c.arrowSize * 0.5, c.arrowBackground);
        node.addChild(backgroundNode);

        const labelNode = new Node();
        const label = labelNode.addComponent(Label);
        label.fontSize = c.arrowFontSize;
        label.fontWeight = 800;
        label.color = c.arrowColor;
        label.text = direction < 0 ? c.previousGlyph : c.nextGlyph;
        node.addChild(labelNode);

        node.on(Input.POINTER_DOWN, () => this._navigate(direction), this);
        this._root.addChild(node);
        this._interactiveNodes.push(node);
    }

    private _makeStatRow(
        index: number,
        title: string,
        maximum: number,
        read: (spec: VehicleSpec) => number,
        format: (value: number) => string,
    ): StatRow {
        const c = cfg.carSelect;
        const y = c.statsFirstY - index * c.statsGap;

        const label = this._makeLabel(c.statLabelX, y, c.statFontSize, c.statLabelColor);
        label.fontWeight = 700;
        label.text = title;

        const track = new Node(c.statBarX, y);
        track.anchorX = 0;
        track.width = c.statBarWidth;
        track.height = c.statBarHeight;
        track.addComponent(ColorRect).color = c.statTrackColor;
        this._root.addChild(track);

        const fill = new Node(c.statBarX, y);
        fill.anchorX = 0;
        fill.width = 0;
        fill.height = c.statBarHeight;
        fill.addComponent(ColorRect).color = c.statFillColor;
        this._root.addChild(fill);

        const value = this._makeLabel(c.statValueX, y, c.statValueFontSize, c.statValueColor, true);
        value.fontWeight = 700;
        return { fill, value, maximum, read, format };
    }

    private _makeDriveButton(): void {
        const c = cfg.carSelect;
        const cx = cfg.design.width / 2;
        const node = new Node(cx, c.driveY);
        node.name = 'DriveThisCarButton';
        node.width = c.driveWidth;
        node.height = c.driveHeight;

        const backgroundNode = new Node();
        const background = backgroundNode.addComponent(Graphics);
        background.tessellate = true;
        background.setStroke(c.driveStroke, 3);
        background.drawRoundedRectangle(c.driveWidth, c.driveHeight, c.driveHeight * 0.5, c.driveBackground);
        node.addChild(backgroundNode);

        const labelNode = new Node();
        const label = labelNode.addComponent(Label);
        label.fontSize = c.driveFontSize;
        label.fontWeight = 800;
        label.color = c.driveColor;
        label.text = c.driveText;
        node.addChild(labelNode);

        node.on(Input.POINTER_DOWN, () => {
            if (this._visible) this._onDrive(this.selectedId);
        }, this);
        this._root.addChild(node);
        this._interactiveNodes.push(node);
    }

    private _navigate(direction: -1 | 1): void {
        if (!this._visible) return;
        const count = cfg.vehicles.models.length;
        const next = (this._index + direction + count) % count;
        const id = cfg.vehicles.models[next].id;
        if (!this._onPreview(id, direction)) return;
        this._index = next;
        this._refresh();
    }

    private _refresh(): void {
        const c = cfg.carSelect;
        const spec = cfg.vehicles.models[this._index];
        this._name.text = spec.label;
        this._description.text = spec.description;
        for (const row of this._stats) {
            const value = row.read(spec);
            row.fill.width = c.statBarWidth * Math.min(1, Math.max(0, value / row.maximum));
            row.value.text = row.format(value);
        }
    }

    private _makeLabel(
        x: number,
        y: number,
        fontSize: number,
        color: string,
        dynamic = false,
    ): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.fontSize = fontSize;
        label.color = color;
        label.dynamic = dynamic;
        label.textAlign = Label.TextAlign.CENTER;
        this._root.addChild(node);
        return label;
    }
}
