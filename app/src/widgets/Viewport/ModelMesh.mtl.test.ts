import { expect, test } from "bun:test";
import * as THREE from "three";
import { MTLLoader } from "./modelLoaders";

test("ModelMesh MTL colors and textures use the correct color spaces", () => {
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.png$/i, {
    load: () => new THREE.Texture(),
  } as unknown as THREE.Loader<THREE.Texture>);
  const material = new MTLLoader(manager)
    .parse(
      [
        "newmtl sample",
        "Kd 0.5 0.5 0.5",
        "Ke 0.5 0.5 0.5",
        "map_Kd color.png",
        "map_Ke emissive.png",
        "map_Bump normal.png",
      ].join("\n"),
      "",
    )
    .create("sample") as THREE.MeshPhongMaterial;
  const expected = new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.SRGBColorSpace);

  expect(material.color.r).toBeCloseTo(expected.r, 10);
  expect(material.emissive.r).toBeCloseTo(expected.r, 10);
  expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
  expect(material.emissiveMap?.colorSpace).toBe(THREE.SRGBColorSpace);
  expect(material.bumpMap?.colorSpace).toBe(THREE.NoColorSpace);
});
