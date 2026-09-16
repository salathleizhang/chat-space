import type { AnimationClip, Object3D } from "three";

export interface LoadedModel {
  object: Object3D;
  animations: AnimationClip[];
}

/**
 * 将一个加载完成的部件登记进装配表。Loader 的底层 Object3D/动画数组才是资源身份；
 * 即使调用方意外重建了外层对象字面量，相同资源也必须返回原 state，不能触发更新环。
 */
export function mergeLoadedModel(
  current: Array<LoadedModel | null>,
  index: number,
  model: LoadedModel,
): Array<LoadedModel | null> {
  const previous = current[index];
  if (previous?.object === model.object && previous.animations === model.animations) return current;
  const next = current.slice();
  next[index] = model;
  return next;
}
