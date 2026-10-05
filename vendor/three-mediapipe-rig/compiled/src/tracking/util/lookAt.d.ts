import { Object3D, Vector3 } from "../../../../../../app/node_modules/@types/three/build/three.webgpu.js";
export type LookAtPoleAxis = "+x" | "+y" | "-x" | "-y";
/**
 * Will point the Z axis of object at target and the X or Y axis in the general direction of the pole target
 * @param object The object to rotate
 * @param target The point to look at ( in world coord )
 * @param poleTarget The goal of the pole axis ( in world coord )
 * @param poleAxis The axis to use as the pole axis ( z is the one pointing at the target )
 */
export declare function lookAt(object: Object3D, target: Vector3, poleTarget: Vector3, poleAxis?: LookAtPoleAxis): void;
