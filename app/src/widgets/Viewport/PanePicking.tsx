import { memo, useEffect, useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { Object3D } from "three";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { SharedPickProxy } from "./sharedPicking";

export const PanePickTarget = memo(function PanePickTarget({ asset, objects, layer, onSelect, onFocus, onHover }: {
  asset: LibraryAsset;
  objects: Map<string, Object3D>;
  layer: number;
  onSelect: (asset: LibraryAsset, additive: boolean) => void;
  onFocus: (asset: LibraryAsset) => void;
  onHover: (layer: number, id: string, entered: boolean) => void;
}) {
  const proxy = useMemo(() => new SharedPickProxy(() => objects.get(asset.id)), [objects, asset.id]);
  useEffect(() => () => onHover(layer, asset.id, false), [onHover, layer, asset.id]);
  return <primitive object={proxy} dispose={null}
    onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); onHover(layer, asset.id, true); }}
    onPointerOut={() => onHover(layer, asset.id, false)}
    onClick={(event: ThreeEvent<MouseEvent>) => { if (event.delta <= 2) { event.stopPropagation(); onSelect(asset, event.nativeEvent.shiftKey); } }}
    onDoubleClick={(event: ThreeEvent<MouseEvent>) => { if (event.delta <= 2) { event.stopPropagation(); onFocus(asset); } }}
  />;
});
