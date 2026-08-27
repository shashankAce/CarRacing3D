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
}

type VehicleSpec = typeof cfg.vehicles.models[number];
type VehicleMaterialKey = 'PixelColors' | 'Glass' | 'Headlights' | 'Fallback';
type VehicleDetail = 'full' | 'distant';

interface VehicleTemplate {
    /** One renderable static mesh per material class for each supported tier. */
    geometries: Record<VehicleDetail, Map<VehicleMaterialKey, THREE.BufferGeometry>>;
}

const MATERIAL_ORDER: VehicleMaterialKey[] = ['PixelColors', 'Glass', 'Headlights', 'Fallback'];

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

    async load(): Promise<void> {
        const cache = assetCache;
        if (!cache) throw new Error('Vehicle models were requested before AssetCache was initialized.');

        const textureLoader = new THREE.TextureLoader();
        const [palette] = await Promise.all([
            textureLoader.loadAsync(cfg.vehicles.paletteTexture),
            ...cfg.vehicles.models.map(async (spec) => {
                const asset = await cache.loadModel(spec.asset, `vehicle:${spec.id}`);
                this._templates.set(spec.id, this._prepareTemplate(spec, asset.scene));
            }),
        ]);
        palette.colorSpace = THREE.SRGBColorSpace;
        palette.magFilter = THREE.NearestFilter;
        palette.minFilter = THREE.NearestMipmapNearestFilter;
        this._palette = palette;
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
            mesh.castShadow = cfg.lighting.shadows.enabled;
            mesh.receiveShadow = true;
            root.add(mesh);
            materials.push(material);
        }

        // Shadow capture still receives all original triangles. Clones are
        // intentional: traffic shifts its first visual's capture geometry into
        // its centre-origin group, and must never mutate shared render geometry.
        const shadowGeometries = [...geometries.values()].map((geometry) => geometry.clone());

        return { root, materials, shadowGeometries };
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
        model.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
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
        return { geometries };
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
            return new THREE.MeshPhysicalMaterial({
                color: source.glass.color,
                roughness: source.glass.roughness,
                metalness: source.glass.metalness,
                transparent: true,
                opacity: source.glass.opacity,
                transmission: source.glass.transmission,
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
    for (const name of ['position', 'normal', 'uv'] as const) {
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
