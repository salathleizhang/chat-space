import { Vector3 } from "../../../../../../app/node_modules/@types/three/index.js";
/**
 * Returns the signed orientation of `vector` around `forward`,
 * using `sideNormal` as the reference axis.
 *
 * > 0  if (forward × vector) points in the same direction as sideNormal
 * < 0  if it points in the opposite direction
 * 0    if vectors are collinear or degenerate
 *
 * All vectors must be in the same coordinate space.
 */
export declare function vectorSign(forward: Vector3, vector: Vector3, sideNormal: Vector3): number;
/**
 * Gets the angle [-π, +π] between from and to. Using "from" as angle 0.
 *
 * > 0  if (from × to) points in the same direction as rotationAxis
 * < 0  if it points in the opposite direction
 * 0    if vectors are collinear or degenerate
 * @param from Normalized origin vector
 * @param to Normalized target vector
 * @param rotationAxis Normalized vector that defines the rotation axis
 * @returns
 */
export declare function signedAngleTo(from: Vector3, to: Vector3, rotationAxis: Vector3): number;
