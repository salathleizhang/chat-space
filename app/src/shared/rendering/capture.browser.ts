import { ACESFilmicToneMapping, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, SRGBColorSpace } from "three";
import { captureScene } from "./capture";
import { NativeWebGPURenderer } from "./webgpu";

/** Real-GPU regression probe, run from the Vite app's browser console:
 * await (await import('/src/shared/rendering/capture.browser.ts')).verifyWebGPUCapture()
 * Uses no project assets and disposes all temporary resources.
 */
export async function verifyWebGPUCapture() {
  const canvas = document.createElement("canvas");
  const renderer = new NativeWebGPURenderer(canvas);
  const geometry = new PlaneGeometry(1, 1);
  const materials = [
    new MeshBasicMaterial({ color: "#888888" }),
    new MeshBasicMaterial({ color: "blue", toneMapped: false }),
  ];
  const errors: unknown[] = [];
  renderer.onError = (error) => errors.push(error);
  try {
    await renderer.init();
    // 65 RGBA pixels require padded GPU rows; a power-of-two fixture misses this.
    renderer.setSize(65, 65, false);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.outputColorSpace = SRGBColorSpace;
    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    materials.forEach((material, i) => {
      const mesh = new Mesh(geometry, material);
      mesh.position.y = 0.5 - i;
      scene.add(mesh);
    });
    renderer.render(scene, camera);
    const displayed = document.createElement("canvas");
    displayed.width = displayed.height = 65;
    const displayContext = displayed.getContext("2d")!;
    displayContext.drawImage(canvas, 0, 0);
    const captured = await captureScene(renderer, scene, camera, 65);
    const captureContext = captured.getContext("2d")!;
    const pixel = (context: CanvasRenderingContext2D, x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
    const displayPixels = [pixel(displayContext, 32, 16), pixel(displayContext, 32, 48), pixel(displayContext, 1, 1)];
    const capturePixels = [pixel(captureContext, 32, 16), pixel(captureContext, 32, 48), pixel(captureContext, 1, 1)];
    if (JSON.stringify(displayPixels) !== JSON.stringify(capturePixels)) throw new Error("Capture colors/orientation differ from the displayed canvas.");
    if (capturePixels[0]![0]! < 100 || capturePixels[1]![2]! < 100 || capturePixels[2]![3] !== 0) throw new Error("Invalid capture content or alpha.");
    if (renderer.getOutputRenderTarget() !== null || renderer.getRenderTarget() !== null) throw new Error("Capture leaked render target state.");
    if (errors.length) throw new Error(JSON.stringify(errors));
    return { width: 65, height: 65, displayPixels, capturePixels, errors };
  } finally {
    geometry.dispose();
    materials.forEach((material) => material.dispose());
    await renderer.dispose();
  }
}
