import { expect, test } from "bun:test";
import * as THREE from "three";
import { hasDrawableContent } from "./drawableContent";

const drawable = () => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());

test("an empty overlay scene is not worth a render pass", () => {
  expect(hasDrawableContent(new THREE.Scene())).toBe(false);
});

test("pick proxies and the empty event group are not drawable", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Object3D()); // SharedPickProxy：只有 raycast，没有几何体
  scene.add(new THREE.Group()); // DrawView 固定挂的 <group onPointerOver>
  expect(hasDrawableContent(scene)).toBe(false);
});

test("one mesh anywhere in the subtree makes the pass necessary", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Object3D());
  const group = new THREE.Group();
  group.add(new THREE.Group());
  group.add(drawable());
  scene.add(group);
  expect(hasDrawableContent(scene)).toBe(true);
});

test("a TransformControls-style gizmo counts through its mesh children", () => {
  const gizmo = new THREE.Object3D();
  gizmo.add(drawable());
  const scene = new THREE.Scene();
  scene.add(gizmo);
  expect(hasDrawableContent(scene)).toBe(true);
});

test("an invisible subtree is skipped whole", () => {
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(drawable());
  const scene = new THREE.Scene();
  scene.add(hidden);
  expect(hasDrawableContent(scene)).toBe(false);
});

test("an invisible material is not a draw call", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false })));
  expect(hasDrawableContent(scene)).toBe(false);
});

test("a multi-material mesh counts when any one material is visible", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BufferGeometry(), [
    new THREE.MeshBasicMaterial({ visible: false }),
    new THREE.MeshBasicMaterial(),
  ]));
  expect(hasDrawableContent(scene)).toBe(true);
});
