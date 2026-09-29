import { ACESFilmicToneMapping, AmbientLight, AnimationMixer, Bone, BoxGeometry, CylinderGeometry,
  DataTexture, DirectionalLight, DoubleSide, Float32BufferAttribute, Group, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera,
  PerspectiveCamera, PlaneGeometry, Quaternion, QuaternionKeyframeTrack, RGBAFormat,
  Scene, Skeleton, SkinnedMesh, SRGBColorSpace, Uint16BufferAttribute, Vector3, AnimationClip } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { NativeWebGPURenderer } from "./webgpu";
import { captureScene } from "./capture";
import { disposeSkeletons } from "./ModelResources";

/** Synthetic, redistributable GLB fixture: no provider calls or project writes.
 * Exercises GLB material/skin/animation parsing and real GPU draws, not every
 * possible exporter extension or mixed Splat/transmission ordering.
 */
export async function verifyWebGPUMaterials() {
  const fixture = new Group();
  const colors = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 255]);
  const alphaMap = new DataTexture(colors, 2, 2, RGBAFormat); alphaMap.needsUpdate = true;
  const materials = [
    new MeshStandardMaterial({ color: "#ff5533", roughness: .35, metalness: .3 }),
    new MeshBasicMaterial({ color: "#3399ff" }),
    new MeshPhysicalMaterial({ color: "#ffffff", transmission: .85, thickness: .4, roughness: .05, clearcoat: 1 }),
    new MeshStandardMaterial({ color: "#66ff88", map: alphaMap, alphaTest: .5, side: DoubleSide }),
    new MeshStandardMaterial({ color: "#cc55ff", transparent: true, opacity: .5, side: DoubleSide }),
  ];
  materials.forEach((material, index) => {
    const mesh = new Mesh(index >= 3 ? new PlaneGeometry(.8, 1.2) : new BoxGeometry(.8, 1.2, .6), material);
    mesh.position.set(index - 2, .4, 0); fixture.add(mesh);
  });
  const skinGeometry = new CylinderGeometry(.25, .25, 1.5, 8, 8);
  const positions = skinGeometry.getAttribute("position");
  const indices: number[] = [], weights: number[] = [];
  for (let index = 0; index < positions.count; index++) {
    const weight = (positions.getY(index) + .75) / 1.5;
    indices.push(0, 1, 0, 0); weights.push(1 - weight, weight, 0, 0);
  }
  skinGeometry.setAttribute("skinIndex", new Uint16BufferAttribute(indices, 4));
  skinGeometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
  const skin = new SkinnedMesh(skinGeometry, new MeshStandardMaterial({ color: "yellow" }));
  skin.name = "AnimatedSkin"; skin.position.set(0, -1.4, 0);
  const root = new Bone(), joint = new Bone(); root.name = "RootBone"; joint.name = "BendingBone";
  root.position.y = -.75; joint.position.y = .75; root.add(joint); skin.add(root);
  skin.bind(new Skeleton([root, joint])); fixture.add(skin);
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.2);
  const clip = new AnimationClip("Bend", 1, [new QuaternionKeyframeTrack("BendingBone.quaternion", [0, .5, 1],
    [0, 0, 0, 1, ...rotation.toArray(), 0, 0, 0, 1])]);
  const disposeTree = (object: Group | Scene) => {
    const geometries = new Set<BoxGeometry | PlaneGeometry | CylinderGeometry>();
    const ownedMaterials = new Set<MeshStandardMaterial | MeshBasicMaterial>();
    object.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) ownedMaterials.add(material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    ownedMaterials.forEach((material) => { material.map?.dispose(); material.dispose(); });
    disposeSkeletons(object);
  };
  const renderer = new NativeWebGPURenderer(document.createElement("canvas"));
  const scene = new Scene(); const errors: unknown[] = [];
  renderer.onError = (error) => errors.push(error);
  try {
    const binary = await new GLTFExporter().parseAsync(fixture, { binary: true, animations: [clip] });
    const loaded = await new GLTFLoader().parseAsync(binary as ArrayBuffer, "");
    scene.add(loaded.scene, new AmbientLight("white", 1.4));
    const light = new DirectionalLight("white", 3); light.position.set(3, 5, 6); scene.add(light);
    await renderer.init(); renderer.setSize(512, 512, false);
    renderer.toneMapping = ACESFilmicToneMapping; renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor("#304050", 1);
    const perspective = new PerspectiveCamera(45, 1, .1, 100); perspective.position.set(0, 0, 8);
    const ortho = new OrthographicCamera(-3.2, 3.2, 3.2, -3.2, .1, 100); ortho.position.z = 8;
    const mixer = new AnimationMixer(loaded.scene); mixer.clipAction(loaded.animations[0]!).play();
    const before = await captureScene(renderer, scene, perspective, 512);
    mixer.update(.5);
    // Node skinning updates once per renderer frame. Compare two frames, not
    // two snapshots in one frame (the latter intentionally freezes the pose).
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = await captureScene(renderer, scene, perspective, 512);
    const orthographic = await captureScene(renderer, scene, ortho, 512);
    const a = before.getContext("2d")!.getImageData(0, 0, 512, 512).data;
    const b = after.getContext("2d")!.getImageData(0, 0, 512, 512).data;
    let changed = 0;
    for (let index = 0; index < a.length; index += 4) if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2]) changed++;
    mixer.stopAllAction(); mixer.uncacheRoot(loaded.scene);
    if (changed < 100) throw new Error("Skinned animation did not change the GPU image.");
    if (errors.length) throw new Error(JSON.stringify(errors));
    return { changedPixels: changed, glbBytes: (binary as ArrayBuffer).byteLength, animationClips: loaded.animations.length,
      errors, perspective: after.toDataURL(), orthographic: orthographic.toDataURL() };
  } finally { disposeTree(fixture); disposeTree(scene); await renderer.dispose(); }
}
