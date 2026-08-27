import * as THREE from 'three';
import { assetCache } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

export type VehicleModelId = string;

export interface VehicleVisual {
    root: THREE.Object3D;
    materials: THREE.Material[];
    /** Static mesh geometry in the vehicle group's local coordinates, for shadow capture. */
    shadowGeometries: THREE.BufferGeometry[];
}

type VehicleSpec = typeof cfg.vehicles.models[number];

/**
 * Loads the shared vehicle catalog once, then supplies normalized static clones.
 *
 * The source files are Unity exports: FBX carries mesh/material names but Unity
 * `.mat` files are not browser assets. The three known material names are
 * translated from `gameConfig.vehicles.materials`, and every clone is shifted so
 * its wheels sit on local y=0 with its centre at local x/z=0.
 */
export class VehicleModels {

    private _templates = new Map<VehicleModelId, THREE.Object3D>();
    private _palette: THREE.Texture | null = null;

    async load(): Promise<void> {
        const cache = assetCache;
        if (!cache) throw new Error('Vehicle models were requested before AssetCache was initialized.');

        const textureLoader = new THREE.TextureLoader();
        const [palette] = await Promise.all([
            textureLoader.loadAsync(cfg.vehicles.paletteTexture),
            ...cfg.vehicles.models.map(async (spec) => {
                const asset = await cache.loadModel(spec.asset, `vehicle:${spec.id}`);
                this._templates.set(spec.id, asset.scene);
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

    create(id: VehicleModelId): VehicleVisual {
        const template = this._templates.get(id);
        if (!template || !this._palette) throw new Error(`Vehicle model "${id}" has not loaded.`);

        const spec = this.spec(id);
        const root = template.clone(true);
        const materials: THREE.Material[] = [];

        root.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            const hadMaterialArray = Array.isArray(object.material);
            const sourceMaterials = hadMaterialArray ? object.material : [object.material];
            const mapped = sourceMaterials.map((material: THREE.Material) => this._createMaterial(material?.name));
            // A material array only renders against geometry groups. Sedan1's
            // wheel meshes have one material and no groups, so keep theirs scalar.
            object.material = hadMaterialArray ? mapped : mapped[0];
            object.castShadow = cfg.lighting.shadows.enabled;
            object.receiveShadow = true;
            materials.push(...mapped);
        });

        // FBX exports use +Z as front while this game drives along -Z.
        root.rotation.y = spec.rotationY;
        root.scale.setScalar(spec.scale);
        root.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(root);
        const centre = bounds.getCenter(new THREE.Vector3());
        root.position.set(-centre.x, -bounds.min.y, -centre.z);

        // Capture the fully normalized FBX mesh rather than a gameplay proxy.
        // `root` has no parent yet, so its world matrices are exactly the local
        // transforms it will have once attached to a player or traffic group.
        root.updateMatrixWorld(true);
        const shadowGeometries: THREE.BufferGeometry[] = [];
        root.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            shadowGeometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
        });

        return { root, materials, shadowGeometries };
    }

    private _createMaterial(name: string | undefined): THREE.Material {
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
