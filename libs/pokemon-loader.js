export class PokemonLoaderClass {
    constructor(THREE_INSTANCE, GLTFLoader_INSTANCE, mixersArray) {
        this.THREE = THREE_INSTANCE;
        this.GLTFLoaderDef = GLTFLoader_INSTANCE;
        this.mixersArray = mixersArray;
        this.tsl = THREE_INSTANCE.TSL;
    }

    createToonMaterial(sourceMaterial) {
        const { THREE, tsl } = this;
        const material = new THREE.MeshToonNodeMaterial();
        material.name = sourceMaterial.name;

        if (tsl && tsl.texture && sourceMaterial.map) {
            material.colorNode = tsl.texture(sourceMaterial.map);
        } else if (tsl && tsl.color) {
            material.colorNode = tsl.color(sourceMaterial.color || 0xffffff);
        }

        material.transparent = sourceMaterial.transparent;
        material.opacity = sourceMaterial.opacity;
        material.alphaTest = sourceMaterial.alphaTest || 0.5;
        material.side = sourceMaterial.side;
        return material;
    }

    applyMaterials(root) {
        root?.traverse((node) => {
            if (!node?.isMesh) return;
            node.castShadow = true;
            node.receiveShadow = true;
            node.material = Array.isArray(node.material)
                ? node.material.map((mat) => this.createToonMaterial(mat))
                : this.createToonMaterial(node.material);
        });
    }

    playIdle(gltf) {
        if (!gltf.animations || gltf.animations.length === 0) return;
        const mixer = new this.THREE.AnimationMixer(gltf.scene);
        const clip = gltf.animations.find((a) => a.name.toLowerCase().includes("wait") || a.name.toLowerCase().includes("idle")) || gltf.animations[0];
        if (clip) mixer.clipAction(clip).play();
        this.mixersArray.push(mixer);
    }

    loadPokemon(path, parentGroup, scaleFactor = 1.0) {
        const loader = new this.GLTFLoaderDef();
        loader.load(path, (gltf) => {
            this.applyMaterials(gltf.scene);
            gltf.scene.scale.set(scaleFactor, scaleFactor, scaleFactor);
            parentGroup.add(gltf.scene);
            this.playIdle(gltf);
        }, undefined, () => {});
    }
}
