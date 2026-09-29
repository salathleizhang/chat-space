import { expect, test } from "bun:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2 } from "three";
import { SharedPickProxy } from "./sharedPicking";

test("per-view pick proxies hit the same shared model without reparenting it", () => {
  const scene = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  scene.add(mesh);
  const proxy = new SharedPickProxy(() => mesh);
  for (const camera of [new PerspectiveCamera(45, 1, 0.1, 100), new OrthographicCamera(-2, 2, 2, -2, 0.1, 100)]) {
    camera.position.z = 5;
    camera.updateMatrixWorld();
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(), camera);
    const hits = ray.intersectObject(proxy);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.object).toBe(proxy);
    expect(hits[0]!.point.z).toBeCloseTo(0.5);
    expect(mesh.parent).toBe(scene);
    expect(proxy.children).toHaveLength(0);
    mesh.visible = false;
    expect(ray.intersectObject(proxy)).toHaveLength(0);
    mesh.visible = true;
  }
  mesh.geometry.dispose(); mesh.material.dispose();
});
