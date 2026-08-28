import * as THREE from 'three';
import { Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { PlayerCar } from '../game/PlayerCar';
import type { TrafficSystem } from '../game/TrafficSystem';

/** Visualises the exact oriented footprints used by player/traffic collision. */
export class CollisionDebugDraw {
    private _line: THREE.LineSegments;
    private _trafficLines: THREE.LineSegments[] = [];
    private _geometry: THREE.EdgesGeometry;
    private _material: THREE.LineBasicMaterial;
    private _trafficMaterial: THREE.LineBasicMaterial;
    private _labelNode: Node;
    private _label: Label;
    private _lastText = '';

    constructor(
        scene: Scene,
        private readonly _threeScene: THREE.Scene,
        private readonly _car: PlayerCar,
        private readonly _traffic: TrafficSystem,
    ) {
        const c = cfg.debug.collisionBox;
        this._geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        this._material = new THREE.LineBasicMaterial({
            color: c.playerColor,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.95,
        });
        this._trafficMaterial = new THREE.LineBasicMaterial({
            color: c.trafficColor,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.95,
        });
        this._line = new THREE.LineSegments(this._geometry, this._material);
        this._line.renderOrder = 2000;
        this._line.frustumCulled = false;
        this._line.visible = false;
        this._threeScene.add(this._line);

        for (let i = 0; i < cfg.traffic.maxAlive; i++) {
            const line = new THREE.LineSegments(this._geometry, this._trafficMaterial);
            line.renderOrder = 2000;
            line.frustumCulled = false;
            line.visible = false;
            this._threeScene.add(line);
            this._trafficLines.push(line);
        }

        this._labelNode = new Node(cfg.design.width / 2, c.labelY);
        this._label = this._labelNode.addComponent(Label);
        this._label.fontSize = c.labelFontSize;
        this._label.color = c.labelColor;
        this._label.fontFamily = 'monospace';
        this._label.dynamic = true;
        this._label.text = '';
        scene.addChild(this._labelNode);
    }

    update(): void {
        const car = this._car;
        const width = car.halfWidth * 2;
        const length = car.halfLength * 2;
        const height = car.visualHeight;

        this._line.visible = true;
        this._line.position.set(
            car.position.x,
            car.position.y + height * 0.5,
            car.position.z,
        );
        this._line.rotation.set(0, car.rotationY, 0);
        this._line.scale.set(width, height, length);

        const yawDegrees = car.rotationY * 180 / Math.PI;
        const text = `COLLISION OBB ${this._format(width)} x ${this._format(length)} m`
            + `   yaw ${yawDegrees.toFixed(1)} deg`;
        if (text !== this._lastText) {
            this._lastText = text;
            this._label.text = text;
        }

        const vehicles = this._traffic.vehicles;
        for (let i = 0; i < this._trafficLines.length; i++) {
            const line = this._trafficLines[i];
            const vehicle = vehicles[i];
            if (!vehicle?.active) {
                line.visible = false;
                continue;
            }

            const obj = vehicle.group.object3D;
            line.visible = true;
            line.position.set(obj.position.x, obj.position.y + vehicle.height * 0.5, obj.position.z);
            line.rotation.set(0, obj.rotation.y, 0);
            line.scale.set(vehicle.halfWidth * 2, vehicle.height, vehicle.halfLength * 2);
        }
    }

    dispose(): void {
        this._threeScene.remove(this._line);
        for (const line of this._trafficLines) this._threeScene.remove(line);
        this._geometry.dispose();
        this._material.dispose();
        this._trafficMaterial.dispose();
        this._labelNode.active = false;
    }

    private _format(value: number): string {
        return value.toFixed(2);
    }
}
