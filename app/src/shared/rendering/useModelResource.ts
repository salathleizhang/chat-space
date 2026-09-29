import { useEffect, useRef } from "react";
import type { Object3D } from "three";
import { modelResources } from "./ModelResources";

export function useModelResource(object: Object3D, clear: () => void) {
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => modelResources.acquire(object, clearRef.current), [object]);
}
