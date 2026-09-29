import { Object3D, type Intersection, type Raycaster } from "three";

/** A per-view event target, without cloning geometry, skeletons or materials. */
export class SharedPickProxy extends Object3D {
  constructor(private readonly source: () => Object3D | undefined) { super(); }

  override raycast(raycaster: Raycaster, intersections: Intersection[]) {
    const source = this.source();
    if (!source || !source.visible) return;
    source.updateWorldMatrix(true, true);
    for (const hit of raycaster.intersectObject(source, true)) {
      // R3F must deliver through this view's store/camera, not the shared root.
      intersections.push({ ...hit, object: this });
    }
  }
}

export const VIEW_LAYERS: Record<string, number> = { persp: 1, top: 2, front: 3, right: 4 };
