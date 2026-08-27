import * as THREE from 'three';
import { assetCache } from 'noonengine';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { gameConfig as cfg } from '../config/gameConfig';

export type VehicleModelId = string;

export interface VehicleVisual {
    root: THREE.Object3D;
    materials: THREE.Material[];
    /** Static mesh geometry in the vehicle group's local coordinates, for shadow capture. */
    shadowGeometries: THREE.BufferGeometry[];
    /** Spins the four custom wheel instances by travelled distance in metres. */
    spinWheels: (distance: number) => void;
}

type VehicleSpec = typeof cfg.vehicles.models[number];
type VehicleMaterialKey = 'PixelColors' | 'Glass' | 'Headlights' | 'Wheel' | 'Fallback';
type VehicleDetail = 'full' | 'distant';

interface VehicleTemplate {
    /** One renderable static mesh per material class for each supported tier. */
    geometries: Record<VehicleDetail, Map<VehicleMaterialKey, THREE.BufferGeometry>>;
    wheels: WheelPlacement[];
}

interface WheelPlacement {
    centre: THREE.Vector3;
    scale: THREE.Vector3;
    radius: number;
}

const MATERIAL_ORDER: VehicleMaterialKey[] = ['PixelColors', 'Glass', 'Headlights', 'Wheel', 'Fallback'];
const WHEEL_NAMES = new Set(['FR', 'FL', 'BR', 'BL']);

/**
 * Loads the shared vehicle catalog once, then supplies normalized static clones.
 *
 * The source files are Unity exports: FBX carries mesh/material names but Unity
 * `.mat` files are not browser assets. The three known material names are
 * translated from `gameConfig.vehicles.materials`, and every clone is shifted so
 * its wheels sit on local y=0 with its centre at local x/z=0.
 */
export class VehicleModels {

    private _templates = new Map<VehicleModelId, VehicleTemplate>();
    private _palette: THREE.Texture | null = null;
    /** Shared test-wheel shape, fitted to each source wheel at template build time. */
    private _testWheel: THREE.BufferGeometry | null = null;

    async load(): Promise<void> {
        const cache = assetCache;
        if (!cache) throw new Error('Vehicle models were requested before AssetCache was initialized.');

        const textureLoader = new THREE.TextureLoader();
        const [palette, ...assets] = await Promise.all([
            textureLoader.loadAsync(cfg.vehicles.paletteTexture),
            ...cfg.vehicles.models.map((spec) => cache.loadModel(spec.asset, `vehicle:${spec.id}`)),
        ]);
        palette.colorSpace = THREE.SRGBColorSpace;
        palette.magFilter = THREE.NearestFilter;
        palette.minFilter = THREE.NearestMipmapNearestFilter;
        this._palette = palette;
        this._testWheel?.dispose();
        this._testWheel = cfg.vehicles.testWheels.enabled
            ? createTestWheelGeometry(cfg.vehicles.testWheels)
            : null;
        // Wheel geometry must exist before templates are prepared; otherwise
        // the async asset-load callbacks bake the original FBX tyres instead.
        for (let i = 0; i < cfg.vehicles.models.length; i++) {
            this._templates.set(
                cfg.vehicles.models[i].id,
                this._prepareTemplate(cfg.vehicles.models[i], assets[i].scene),
            );
        }
    }

    spec(id: VehicleModelId): VehicleSpec {
        const spec = cfg.vehicles.models.find((entry) => entry.id === id);
        if (!spec) throw new Error(`Unknown vehicle model "${id}".`);
        return spec;
    }

    create(id: VehicleModelId, detail: VehicleDetail = 'full'): VehicleVisual {
        const template = this._templates.get(id);
        if (!template || !this._palette) throw new Error(`Vehicle model "${id}" has not loaded.`);

        const root = new THREE.Group();
        const materials: THREE.Material[] = [];
        const geometries = template.geometries[detail];

        // The FBXs are static. Their original 8–10 meshes and 33–40 material
        // groups were the source of hundreds of mobile draw calls for traffic.
        // Templates bake every part's local transform once, then create only
        // one mesh per material class here. Geometry remains shared between all
        // pool slots; only the three materials are per-visual because player and
        // traffic receivers need different projected-shadow `skip` values.
        for (const key of MATERIAL_ORDER) {
            const geometry = geometries.get(key);
            if (!geometry) continue;
            const material = this._createMaterial(key);
            const mesh = new THREE.Mesh(geometry, material);
            root.add(mesh);
            materials.push(material);
        }

        // Shadow capture still receives all original triangles. Clones are
        // intentional: traffic shifts its first visual's capture geometry into
        // its centre-origin group, and must never mutate shared render geometry.
        const shadowGeometries = [...geometries.values()].map((geometry) => geometry.clone());
        let spinWheels: (distance: number) => void = () => {};
        if (this._testWheel && template.wheels.length > 0) {
            const material = this._createMaterial('Wheel');
            const wheels = new THREE.InstancedMesh(this._testWheel, material, template.wheels.length);
            root.add(wheels);
            materials.push(material);

            if (!this._testWheel.boundingBox) this._testWheel.computeBoundingBox();
            const baseBox = this._testWheel.boundingBox!;
            const baseCentre = baseBox.getCenter(new THREE.Vector3());
            const offset = new THREE.Matrix4().makeTranslation(-baseCentre.x, -baseCentre.y, -baseCentre.z);
            const matrix = new THREE.Matrix4();
            const rotation = new THREE.Quaternion();
            const axis = new THREE.Vector3(1, 0, 0);
            const setWheelMatrices = (distance: number) => {
                for (let i = 0; i < template.wheels.length; i++) {
                    const wheel = template.wheels[i];
                    rotation.setFromAxisAngle(axis, -distance / wheel.radius * cfg.vehicles.testWheels.rotationSpeed);
                    matrix.compose(wheel.centre, rotation, wheel.scale).multiply(offset);
                    wheels.setMatrixAt(i, matrix);
                }
                wheels.instanceMatrix.needsUpdate = true;
            };
            setWheelMatrices(0);
            spinWheels = setWheelMatrices;

            // Projected-shadow capture needs ordinary world-local geometries,
            // not instance matrices. Capture the zero-rotation wheel pose.
            for (const wheel of template.wheels) {
                matrix.compose(wheel.centre, new THREE.Quaternion(), wheel.scale).multiply(offset);
                shadowGeometries.push(this._testWheel.clone().applyMatrix4(matrix));
            }
        }

        return { root, materials, shadowGeometries, spinWheels };
    }

    /** Builds the compact, normalised static geometry for one FBX once at load. */
    private _prepareTemplate(spec: VehicleSpec, source: THREE.Object3D): VehicleTemplate {
        const model = source.clone(true);
        // FBX exports use +Z as front while this game drives along -Z.
        model.rotation.y = spec.rotationY;
        model.scale.setScalar(spec.scale);
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const centre = bounds.getCenter(new THREE.Vector3());
        model.position.set(-centre.x, -bounds.min.y, -centre.z);
        model.updateMatrixWorld(true);

        const batches: Record<VehicleDetail, Map<VehicleMaterialKey, THREE.BufferGeometry[]>> = {
            full: new Map(),
            distant: new Map(),
        };
        const wheels: WheelPlacement[] = [];
        model.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            if (this._testWheel && WHEEL_NAMES.has(object.name)) {
                wheels.push(this._fitTestWheel(object));
                return;
            }
            const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
            const groups = object.geometry.groups.length > 0
                ? object.geometry.groups
                : [{ start: 0, count: object.geometry.getIndex()?.count ?? object.geometry.getAttribute('position').count, materialIndex: 0 }];
            for (const group of groups) {
                const key = this._materialKey(sourceMaterials[group.materialIndex]?.name);
                const part = sliceGroup(object.geometry, group.start, group.count);
                // This leaves every compact mesh in the vehicle root's local
                // space, exactly matching the old hierarchy after normalisation.
                part.applyMatrix4(object.matrixWorld);
                this._appendBatch(batches.full, key, part);
                // Simplify each original part BEFORE it is batched by material.
                // A tyre is a small disconnected island beside the body in the
                // PixelColors batch. Simplifying the merged batch let the edge
                // collapses spend the whole reduction budget on those small
                // islands, which could make distant tyres disappear.
                const lodPart = sliceGroup(object.geometry, group.start, group.count);
                lodPart.applyMatrix4(object.matrixWorld);
                const simplifiedPart = simplifyGeometry(lodPart, spec.lod.vertexReduction);
                lodPart.dispose();
                this._appendBatch(batches.distant, key, simplifiedPart);
            }
        });

        const geometries: Record<VehicleDetail, Map<VehicleMaterialKey, THREE.BufferGeometry>> = {
            full: new Map(),
            distant: new Map(),
        };
        for (const detail of ['full', 'distant'] as const) {
            for (const key of MATERIAL_ORDER) {
                const parts = batches[detail].get(key);
                if (parts && parts.length > 0) geometries[detail].set(key, mergeStaticParts(parts));
            }
        }
        // The distant tier still has only one draw per material class, but its
        // body, wheels, glass, lights, doors and interior have each received
        // the same configurable reduction before batching.
        return { geometries, wheels };
    }

    private _appendBatch(
        batches: Map<VehicleMaterialKey, THREE.BufferGeometry[]>,
        key: VehicleMaterialKey,
        part: THREE.BufferGeometry,
    ): void {
        const list = batches.get(key) ?? [];
        list.push(part);
        batches.set(key, list);
    }

    /** Fits the configured wheel to the position and dimensions of one FBX tyre. */
    private _fitTestWheel(target: THREE.Mesh): WheelPlacement {
        if (!this._testWheel!.boundingBox) this._testWheel!.computeBoundingBox();
        const sourceBox = this._testWheel!.boundingBox!;
        const sourceSize = sourceBox.getSize(new THREE.Vector3());
        const targetBox = new THREE.Box3().setFromObject(target);
        const targetCentre = targetBox.getCenter(new THREE.Vector3());
        const targetSize = targetBox.getSize(new THREE.Vector3());
        return {
            centre: targetCentre,
            scale: new THREE.Vector3(
            targetSize.x / Math.max(sourceSize.x, 1e-5),
            targetSize.y / Math.max(sourceSize.y, 1e-5),
            targetSize.z / Math.max(sourceSize.z, 1e-5),
            ),
            radius: Math.max(targetSize.y, targetSize.z) * 0.5,
        };
    }

    private _materialKey(name: string | undefined): VehicleMaterialKey {
        if (name === 'PixelColors' || name === 'Glass' || name === 'Headlights') return name;
        return 'Fallback';
    }

    private _createMaterial(name: VehicleMaterialKey): THREE.Material {
        const source = cfg.vehicles.materials;
        if (name === 'PixelColors') {
            return new THREE.MeshStandardMaterial({
                map: this._palette!,
                roughness: source.pixelColors.roughness,
                metalness: source.pixelColors.metalness,
            });
        }
        if (name === 'Glass') {
            // Keep the authored dark transparent-glass look without enabling
            // MeshPhysicalMaterial's transmission pipeline. In three.js ANY
            // transmission value above zero triggers a full-resolution,
            // multisampled scene pre-pass plus mip generation; the previous
            // 0.05 therefore paid the full cost for a barely visible effect.
            return new THREE.MeshStandardMaterial({
                color: source.glass.color,
                roughness: source.glass.roughness,
                metalness: source.glass.metalness,
                transparent: true,
                opacity: source.glass.opacity,
            });
        }
        if (name === 'Headlights') {
            return new THREE.MeshStandardMaterial({
                color: source.headlights.color,
                emissive: source.headlights.emissive,
                emissiveIntensity: source.headlights.emissiveIntensity,
                roughness: source.headlights.roughness,
            });
        }
        if (name === 'Wheel') {
            const wheel = cfg.vehicles.testWheels;
            return new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: wheel.roughness,
                metalness: wheel.metalness,
            });
        }
        return new THREE.MeshStandardMaterial({ color: 0x9da9b7, roughness: 0.65 });
    }
}

/**
 * Extracts one FBX material group as standalone, non-indexed geometry. The
 * bundled car files have position/normal/UV only; keeping that narrow contract
 * means no general-purpose geometry utility needs to enter the playable.
 */
function sliceGroup(source: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
    const index = source.getIndex();
    const result = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv'] as const) {
        const attribute = source.getAttribute(name);
        if (!attribute) throw new Error(`Vehicle geometry is missing ${name}.`);
        const values = new Float32Array(count * attribute.itemSize);
        for (let i = 0; i < count; i++) {
            const sourceIndex = index ? index.getX(start + i) : start + i;
            for (let component = 0; component < attribute.itemSize; component++) {
                values[i * attribute.itemSize + component] = attribute.array[sourceIndex * attribute.itemSize + component];
            }
        }
        result.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    }
    return result;
}

/** Concatenates already non-indexed vehicle parts without changing triangle count. */
function mergeStaticParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    if (parts.length === 1) {
        const single = parts[0];
        single.computeBoundingSphere();
        return single;
    }

    const result = new THREE.BufferGeometry();
    const names = (['position', 'normal', 'uv', 'color'] as const)
        .filter((name) => parts.every((part) => part.getAttribute(name) !== undefined));
    for (const name of names) {
        const itemSize = parts[0].getAttribute(name).itemSize;
        const total = parts.reduce((count, part) => count + part.getAttribute(name).count, 0);
        const values = new Float32Array(total * itemSize);
        let offset = 0;
        for (const part of parts) {
            const attribute = part.getAttribute(name);
            if (attribute.itemSize !== itemSize) throw new Error(`Vehicle ${name} attributes do not match.`);
            values.set(attribute.array as Float32Array, offset);
            offset += attribute.count * itemSize;
        }
        result.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
    }
    for (const part of parts) part.dispose();
    result.computeBoundingSphere();
    return result;
}

/**
 * Produces a textured, reduced version of a real vehicle material batch for distant
 * traffic. UV seams remain protected by `mergeVertices`, so PixelColors keeps
 * its intended palette rather than smearing across panels.
 */
function simplifyGeometry(source: THREE.BufferGeometry, vertexReduction: number): THREE.BufferGeometry {
    const welded = mergeVertices(source);
    const vertices = welded.getAttribute('position').count;
    // Keep enough vertices for a closed vehicle silhouette even if a reskin
    // sets a very aggressive ratio. The modifier works in removed vertices,
    // not target triangles.
    const remove = Math.max(0, Math.min(
        vertices - 12,
        Math.floor(vertices * THREE.MathUtils.clamp(vertexReduction, 0, 0.9)),
    ));
    if (remove === 0) {
        welded.computeBoundingSphere();
        return welded;
    }
    const simplified = new SimplifyModifier().modify(welded, remove);
    welded.dispose();
    simplified.computeBoundingSphere();
    return simplified;
}

/** Creates the hollow-cylinder test wheel approved in tyre.html. */
function createTestWheelGeometry(options: typeof cfg.vehicles.testWheels): THREE.BufferGeometry {
    const outerRadius = 0.82;
    const innerRadius = options.rimSize + 0.045;
    const parts: THREE.BufferGeometry[] = [
        tintGeometry(
            hollowCylinderGeometry(outerRadius, innerRadius, options.tyreWidth, options.tyreSegments),
            options.tyreColor,
        ),
    ];

    // The opaque far side keeps the wheel from reading as a tunnel through the
    // spoke opening when it is viewed from the usual outside angle.
    const back = new THREE.CircleGeometry(outerRadius, options.tyreSegments);
    back.rotateY(Math.PI / 2);
    back.translate(-options.tyreWidth * 0.505, 0, 0);
    parts.push(tintGeometry(back, options.tyreColor));

    for (let i = 0; i < options.fullDiameterBars; i++) {
        // A 180° turn produces the same full-diameter bar, hence π/count.
        const angle = options.barRotation + i * Math.PI / options.fullDiameterBars;
        const spoke = new THREE.BoxGeometry(options.tyreWidth * options.barWidthFactor, innerRadius * 2, 0.075);
        spoke.rotateX(-angle);
        parts.push(tintGeometry(spoke, options.spokeColor));
    }
    return mergeStaticParts(parts);
}

/** Hollow sharp-edged cylinder with its axle on X, matching the source FBXs. */
function hollowCylinderGeometry(
    outerRadius: number,
    innerRadius: number,
    width: number,
    segments: number,
): THREE.BufferGeometry {
    const positions: number[] = [];
    const indices: number[] = [];
    const halfWidth = width * 0.5;
    for (let i = 0; i < segments; i++) {
        const angle = i * Math.PI * 2 / segments;
        const y = Math.cos(angle);
        const z = Math.sin(angle);
        // Outer left/right, followed by inner left/right.
        positions.push(-halfWidth, y * outerRadius, z * outerRadius, halfWidth, y * outerRadius, z * outerRadius);
        positions.push(-halfWidth, y * innerRadius, z * innerRadius, halfWidth, y * innerRadius, z * innerRadius);
    }
    for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments;
        const a = i * 4;
        const b = next * 4;
        indices.push(a, b, b + 1, a, b + 1, a + 1);                 // outer wall
        indices.push(a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);     // inner wall
        indices.push(a, a + 2, b + 2, a, b + 2, b);                 // left face
        indices.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3);     // right face
    }
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    indexed.setIndex(indices);
    const flat = indexed.toNonIndexed();
    indexed.dispose();
    flat.computeVertexNormals();
    return flat;
}

/** Adds a constant vertex colour so tyre and spokes remain one draw call. */
function tintGeometry(source: THREE.BufferGeometry, colorValue: number): THREE.BufferGeometry {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const color = new THREE.Color(colorValue);
    const count = geometry.getAttribute('position').count;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) color.toArray(values, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
    return geometry;
}
