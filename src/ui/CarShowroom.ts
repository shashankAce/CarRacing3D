import * as THREE from 'three';
import type { Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { VehicleModels, VehicleModelId, VehicleVisual } from '../assets/VehicleModels';

type ThreeSystem = NonNullable<Scene['threeSceneSystem']>;
type ShowroomCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

interface PreviewCar {
    holder: THREE.Group;
    visual: VehicleVisual;
}

interface ShowroomSpotlight {
    light: THREE.SpotLight;
    baseAngle: number;
}

/**
 * A camera-layer-isolated vehicle showroom.
 *
 * Gameplay geometry and its directional sun remain on Three's default layer 0.
 * The showroom camera renders only `carSelect.showroom.layer`, so none of the
 * road, terrain, sky, traffic, clouds, or sun can leak into this screen. The
 * turntable uses its own ambient fill and fixed spotlights instead.
 */
export class CarShowroom {

    private readonly _system: ThreeSystem;
    private readonly _models: VehicleModels;
    private readonly _root = new THREE.Group();
    private readonly _turntable = new THREE.Group();
    private readonly _camera: THREE.PerspectiveCamera;
    private readonly _ownedGeometries: THREE.BufferGeometry[] = [];
    private readonly _ownedMaterials: THREE.Material[] = [];
    private readonly _spotlights: ShowroomSpotlight[] = [];

    private _current: PreviewCar | null = null;
    private _incoming: PreviewCar | null = null;
    private _transitionElapsed = 0;
    private _transitionDirection = 1;
    private _visible = false;
    private _dragging = false;
    private _autoRotateDelay = 0;
    private _targetFov: number;
    private _fitDimensions: VehicleVisual['dimensions'] | null = null;
    private _fitMultiplier = 1;
    private _lastFitAspect = -1;
    private readonly _screenRight = new THREE.Vector3();
    private readonly _entryPosition = new THREE.Vector3();
    private readonly _cameraTarget = new THREE.Vector3();
    private readonly _cameraDirection = new THREE.Vector3();
    private _baseCameraDistance = 1;
    private _cameraDistance = 1;
    private _targetCameraDistance = 1;
    private _targetLookY = 0;
    private readonly _entrySideYaw: number;

    private _previousCamera: ShowroomCamera | null = null;
    private _previousBackground: THREE.Scene['background'] = null;
    private _previousFog: THREE.Scene['fog'] = null;

    constructor(system: ThreeSystem, models: VehicleModels) {
        this._system = system;
        this._models = models;

        const c = cfg.carSelect.showroom;
        this._camera = new THREE.PerspectiveCamera(
            c.camera.fov,
            cfg.design.width / cfg.design.height,
            c.camera.near,
            c.camera.far,
        );
        this._camera.position.set(c.camera.position.x, c.camera.position.y, c.camera.position.z);
        this._cameraTarget.set(c.camera.target.x, c.camera.target.y, c.camera.target.z);
        this._cameraDirection.copy(this._camera.position).sub(this._cameraTarget);
        this._baseCameraDistance = this._cameraDirection.length();
        this._cameraDistance = this._baseCameraDistance;
        this._targetCameraDistance = this._baseCameraDistance;
        this._targetLookY = this._cameraTarget.y;
        this._cameraDirection.normalize();
        this._camera.lookAt(this._cameraTarget);
        this._camera.updateMatrixWorld(true);
        this._camera.layers.set(c.layer);
        this._targetFov = c.camera.fov;
        this._screenRight.setFromMatrixColumn(this._camera.matrixWorld, 0).setY(0).normalize();
        const cameraDirection = this._cameraDirection.clone().setY(0).normalize();
        // Local +X points toward the camera, so the incoming vehicle presents
        // its full side profile instead of inheriting the platform's yaw.
        this._entrySideYaw = Math.atan2(-cameraDirection.z, cameraDirection.x);

        this._root.visible = false;
        this._root.layers.set(c.layer);
        this._turntable.rotation.y = c.initialRotation;
        this._root.add(this._turntable);
        this._buildRoom();
        // this._buildCeilingLights();
        this._buildTurntable();
        this._buildLights();
        this._root.traverse((object) => object.layers.set(c.layer));
        this._system.scene.add(this._root);
    }

    /** Enables the only real-time shadow maps used by this project. */
    configureRenderer(renderer: THREE.WebGLRenderer): void {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    show(initialId: VehicleModelId): void {
        if (this._visible) return;
        this._visible = true;

        const scene = this._system.scene;
        this._previousCamera = this._system.camera;
        this._previousBackground = scene.background;
        this._previousFog = scene.fog;

        if (this._previousCamera instanceof THREE.PerspectiveCamera) {
            this._camera.aspect = this._previousCamera.aspect;
            this._camera.updateProjectionMatrix();
        }
        scene.background = new THREE.Color(cfg.carSelect.showroom.background);
        scene.fog = null;
        this._system.camera = this._camera;
        this._root.visible = true;
        this._startTransition(initialId, 1);
    }

    /** Starts a side-entry swap; false lets the UI ignore rapid repeated taps. */
    select(id: VehicleModelId, direction: number): boolean {
        if (!this._visible || this._incoming) return false;
        this._startTransition(id, direction < 0 ? -1 : 1);
        return true;
    }

    setDragging(dragging: boolean): void {
        this._dragging = dragging;
        if (!dragging) this._autoRotateDelay = cfg.carSelect.showroom.drag.autoResumeDelay;
    }

    rotateBy(screenDeltaX: number): void {
        if (!this._visible || this._incoming) return;
        this._turntable.rotation.y += screenDeltaX * cfg.carSelect.showroom.drag.sensitivity;
        this._autoRotateDelay = cfg.carSelect.showroom.drag.autoResumeDelay;
    }

    update(dt: number): void {
        if (!this._visible) return;
        const c = cfg.carSelect.showroom;
        if (this._dragging) this._autoRotateDelay = c.drag.autoResumeDelay;
        else if (this._autoRotateDelay > 0) this._autoRotateDelay -= dt;
        else this._turntable.rotation.y += c.rotationSpeed * dt;

        if (this._fitDimensions && Math.abs(this._lastFitAspect - this._camera.aspect) > 0.0001) {
            this._updateTargetFov(this._fitDimensions, this._fitMultiplier);
        }
        const fovK = 1 - Math.exp(-c.camera.fovResponse * dt);
        this._cameraTarget.y += (this._targetLookY - this._cameraTarget.y) * fovK;
        this._cameraDistance += (this._targetCameraDistance - this._cameraDistance) * fovK;
        this._camera.position.copy(this._cameraTarget)
            .addScaledVector(this._cameraDirection, this._cameraDistance);
        this._camera.fov += (this._targetFov - this._camera.fov) * fovK;
        this._camera.lookAt(this._cameraTarget);
        this._camera.updateMatrixWorld(true);
        this._camera.updateProjectionMatrix();

        if (!this._incoming) return;
        this._transitionElapsed += Math.min(dt, 0.05);
        const t = THREE.MathUtils.clamp(
            this._transitionElapsed / Math.max(c.transition.duration, 0.001),
            0,
            1,
        );
        const eased = t * t * (3 - 2 * t);
        const slide = c.transition.slideDistance;

        const offset = this._transitionDirection * slide * (1 - eased);
        this._incoming.holder.position.copy(this._entryPosition)
            .addScaledVector(this._screenRight, offset);

        if (t < 1) return;
        // Reparent only after reaching the centre. Object3D.attach preserves the
        // side-profile world yaw, then future platform rotation carries the car.
        this._root.updateMatrixWorld(true);
        this._turntable.attach(this._incoming.holder);
        this._current = this._incoming;
        this._incoming = null;
    }

    hide(): void {
        if (!this._visible) return;
        this._visible = false;
        this._root.visible = false;

        const previews = new Set([this._current, this._incoming]);
        for (const preview of previews) if (preview) this._releasePreview(preview);
        this._current = null;
        this._incoming = null;
        this._fitDimensions = null;
        this._fitMultiplier = 1;

        // The active showroom camera may have received resize updates. Copy its
        // aspect back so gameplay cannot return with a stale projection.
        if (this._previousCamera instanceof THREE.PerspectiveCamera) {
            this._previousCamera.aspect = this._camera.aspect;
            this._previousCamera.updateProjectionMatrix();
        }
        this._system.camera = this._previousCamera;
        this._system.scene.background = this._previousBackground;
        this._system.scene.fog = this._previousFog;
        this._previousCamera = null;
    }

    dispose(): void {
        this.hide();
        this._system.scene.remove(this._root);
        for (const geometry of this._ownedGeometries) geometry.dispose();
        for (const material of this._ownedMaterials) material.dispose();
        this._ownedGeometries.length = 0;
        this._ownedMaterials.length = 0;
    }

    private _startTransition(id: VehicleModelId, direction: number): void {
        if (this._current) this._releasePreview(this._current);
        this._current = null;
        const preview = this._createPreview(id);
        this._transitionDirection = direction;
        this._transitionElapsed = 0;
        this._incoming = preview;

        const transition = cfg.carSelect.showroom.transition;
        preview.holder.position.copy(this._entryPosition)
            .addScaledVector(this._screenRight, direction * transition.slideDistance);
    }

    private _createPreview(id: VehicleModelId): PreviewCar {
        // Showroom previews never enter projected-shadow capture, avoiding a
        // complete clone of every render geometry each time an arrow is tapped.
        const visual = this._models.create(id, 'showroom', false);
        const holder = new THREE.Group();
        this._entryPosition.set(0, cfg.carSelect.showroom.platform.topY, 0);
        holder.position.copy(this._entryPosition);
        holder.rotation.y = this._entrySideYaw;
        holder.add(visual.root);
        holder.traverse((object) => {
            object.layers.set(cfg.carSelect.showroom.layer);
            if (object instanceof THREE.Mesh) {
                object.castShadow = true;
                object.receiveShadow = true;
            }
        });
        this._root.add(holder);
        this._fitDimensions = visual.dimensions;
        this._fitMultiplier = cfg.carSelect.showroom.camera.fitOverrides[id] ?? 1;
        this._updateTargetFov(visual.dimensions, this._fitMultiplier);
        this._updateSpotlights(visual.dimensions);
        return { holder, visual };
    }

    private _releasePreview(preview: PreviewCar): void {
        preview.holder.parent?.remove(preview.holder);
        for (const material of preview.visual.materials) material.dispose();
        for (const geometry of preview.visual.shadowGeometries) geometry.dispose();
    }

    private _updateTargetFov(dimensions: VehicleVisual['dimensions'], fitMultiplier: number): void {
        const c = cfg.carSelect.showroom.camera;
        const padding = c.fitPadding * fitMultiplier;
        const footprintRadius = Math.hypot(dimensions.width, dimensions.length) * 0.5 * padding;
        const verticalRadius = dimensions.height * 0.5 * padding;
        const aspect = Math.max(this._camera.aspect, 0.2);
        const requiredHalfHeight = Math.max(verticalRadius, footprintRadius / aspect);
        const halfAngle = Math.atan(requiredHalfHeight / this._baseCameraDistance);
        this._targetFov = THREE.MathUtils.clamp(
            THREE.MathUtils.radToDeg(halfAngle * 2),
            c.minFov,
            c.maxFov,
        );

        // On narrow screens a large vehicle can require more than maxFov.
        // Preserve the comfortable FOV cap and move the camera back instead;
        // this is what makes the framing genuinely responsive to screen aspect.
        const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(this._targetFov * 0.5));
        this._targetCameraDistance = Math.max(
            this._baseCameraDistance,
            requiredHalfHeight / Math.max(halfFovTangent, 0.0001),
        );
        this._targetLookY = cfg.carSelect.showroom.platform.topY
            + dimensions.height * c.vehicleCenterHeightFactor;
        this._lastFitAspect = this._camera.aspect;
    }

    private _updateSpotlights(dimensions: VehicleVisual['dimensions']): void {
        const c = cfg.carSelect.showroom;
        const targetY = c.platform.topY + dimensions.height * 0.5;
        // A padded bounding sphere keeps every corner inside each cone even
        // while a long vehicle rotates through its widest diagonal profile.
        const coverageRadius = Math.hypot(
            dimensions.width * 0.5,
            dimensions.height * 0.5,
            dimensions.length * 0.5,
        ) * c.spotlightCoveragePadding;

        for (const { light, baseAngle } of this._spotlights) {
            light.target.position.set(0, targetY, 0);
            const distance = light.position.distanceTo(light.target.position);
            const requiredAngle = Math.asin(THREE.MathUtils.clamp(
                coverageRadius / Math.max(distance, 0.0001),
                0,
                0.999,
            ));
            light.angle = THREE.MathUtils.clamp(
                Math.max(baseAngle, requiredAngle),
                baseAngle,
                c.spotlightMaxAngle,
            );
            light.target.updateMatrixWorld(true);
        }
    }

    private _buildRoom(): void {
        const p = cfg.carSelect.showroom.platform;
        const ceiling = cfg.carSelect.showroom.ceiling;

        const floorGeometry = new THREE.CircleGeometry(12, 64);
        floorGeometry.rotateX(-Math.PI / 2);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: p.floorColor,
            roughness: 0.82,
            metalness: 0.12,
        });
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.position.y = -0.015;
        floor.receiveShadow = true;
        this._root.add(floor);

        const wallGeometry = new THREE.CylinderGeometry(
            11.8,
            11.8,
            ceiling.height,
            64,
            1,
            true,
        );
        const wallMaterial = new THREE.MeshStandardMaterial({
            color: p.wallColor,
            roughness: 0.9,
            metalness: 0.05,
            side: THREE.BackSide,
        });
        const wall = new THREE.Mesh(wallGeometry, wallMaterial);
        wall.position.y = ceiling.height * 0.5;
        wall.receiveShadow = true;
        this._root.add(wall);

        const ceilingGeometry = new THREE.CircleGeometry(11.8, 64);
        ceilingGeometry.rotateX(Math.PI / 2);
        const ceilingMaterial = new THREE.MeshStandardMaterial({
            color: ceiling.color,
            roughness: ceiling.roughness,
            metalness: ceiling.metalness,
        });
        const ceilingMesh = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
        ceilingMesh.position.y = ceiling.height;
        ceilingMesh.receiveShadow = true;
        this._root.add(ceilingMesh);

        this._ownedGeometries.push(floorGeometry, wallGeometry, ceilingGeometry);
        this._ownedMaterials.push(floorMaterial, wallMaterial, ceilingMaterial);
    }

    /*
    private _buildCeilingLights(): void {
        const c = cfg.carSelect.showroom.ceiling;
        const fixture = new THREE.Group();
        fixture.rotation.set(c.rotation.x, c.rotation.y, c.rotation.z);
        this._root.add(fixture);

        const hexWidth = Math.sqrt(3) * c.hexRadius;
        const rowZ = [-c.hexRadius * 1.5, 0, c.hexRadius * 1.5];
        const centers = [
            ...[-hexWidth, 0, hexWidth].map((x) => new THREE.Vector2(x, rowZ[0])),
            ...[-hexWidth * 0.5, hexWidth * 0.5].map((x) => new THREE.Vector2(x, rowZ[1])),
            ...[-hexWidth, 0, hexWidth].map((x) => new THREE.Vector2(x, rowZ[2])),
        ];

        const tubeGeometry = new THREE.CylinderGeometry(
            c.tubeRadius,
            c.tubeRadius,
            1,
            10,
        );
        const tubeMaterial = new THREE.MeshBasicMaterial({
            color: c.lightColor,
            toneMapped: false,
        });
        const up = new THREE.Vector3(0, 1, 0);
        const edges = new Map<string, [THREE.Vector3, THREE.Vector3]>();

        // Build a tiled 3-2-3 honeycomb and merge coincident borders so the
        // shared edges stay the same brightness as the outside edges.
        for (const center of centers) {
            const vertices: THREE.Vector3[] = [];
            for (let i = 0; i < 6; i++) {
                const angle = Math.PI / 6 + i * Math.PI / 3;
                vertices.push(new THREE.Vector3(
                    center.x + Math.cos(angle) * c.hexRadius,
                    c.lightHeight,
                    center.y + Math.sin(angle) * c.hexRadius,
                ));
            }
            for (let i = 0; i < 6; i++) {
                const from = vertices[i];
                const to = vertices[(i + 1) % 6];
                const fromKey = `${from.x.toFixed(4)},${from.z.toFixed(4)}`;
                const toKey = `${to.x.toFixed(4)},${to.z.toFixed(4)}`;
                const key = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
                if (!edges.has(key)) edges.set(key, [from, to]);
            }
        }

        for (const [from, to] of edges.values()) {
            const direction = to.clone().sub(from);
            const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
            tube.position.copy(from).add(to).multiplyScalar(0.5);
            tube.quaternion.setFromUnitVectors(up, direction.clone().normalize());
            tube.scale.y = direction.length();
            fixture.add(tube);
        }

        this._ownedGeometries.push(tubeGeometry);
        this._ownedMaterials.push(tubeMaterial);
    }
    */

    private _buildTurntable(): void {
        const p = cfg.carSelect.showroom.platform;
        const baseGeometry = new THREE.CylinderGeometry(p.radius, p.radius * 1.04, p.height, 64);
        const baseMaterial = new THREE.MeshStandardMaterial({
            color: p.color,
            roughness: p.roughness,
            metalness: p.metalness,
        });
        const base = new THREE.Mesh(baseGeometry, baseMaterial);
        base.position.y = p.height * 0.5;
        base.receiveShadow = true;
        this._turntable.add(base);

        const rimGeometry = new THREE.TorusGeometry(p.radius * 0.97, 0.035, 8, 64);
        rimGeometry.rotateX(Math.PI / 2);
        const rimMaterial = new THREE.MeshBasicMaterial({ color: p.rimColor });
        const rim = new THREE.Mesh(rimGeometry, rimMaterial);
        rim.position.y = p.topY + 0.015;
        this._turntable.add(rim);

        const tickGeometry = new THREE.BoxGeometry(0.035, 0.012, 0.30);
        const tickMaterial = new THREE.MeshBasicMaterial({ color: p.rimColor });
        for (let i = 0; i < 12; i++) {
            const angle = i * Math.PI * 2 / 12;
            const tick = new THREE.Mesh(tickGeometry, tickMaterial);
            tick.position.set(Math.sin(angle) * p.radius * 0.78, p.topY + 0.02, Math.cos(angle) * p.radius * 0.78);
            tick.rotation.y = angle;
            this._turntable.add(tick);
        }

        this._ownedGeometries.push(baseGeometry, rimGeometry, tickGeometry);
        this._ownedMaterials.push(baseMaterial, rimMaterial, tickMaterial);
    }

    private _buildLights(): void {
        const c = cfg.carSelect.showroom;
        const ambient = new THREE.AmbientLight(c.ambient.color, c.ambient.intensity);
        this._root.add(ambient);

        for (const spec of c.spotlights) {
            const light = new THREE.SpotLight(
                spec.color,
                spec.intensity,
                spec.distance,
                spec.angle,
                spec.penumbra,
                2,
            );
            light.position.set(spec.position.x, spec.position.y, spec.position.z);
            light.castShadow = true;
            light.shadow.mapSize.set(c.shadowMapSize, c.shadowMapSize);
            light.shadow.camera.layers.set(c.layer);
            light.shadow.bias = -0.0004;
            light.shadow.normalBias = 0.025;
            light.target.position.set(0, 0.8, 0);
            this._root.add(light, light.target);
            this._spotlights.push({ light, baseAngle: spec.angle });
        }
    }
}
