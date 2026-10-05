import * as THREE from "../../../../../app/node_modules/@types/three/build/three.webgpu.js";
import { Landmark, NormalizedLandmark, DrawingUtils } from "../../../../../app/node_modules/@mediapipe/tasks-vision/vision";
import { LookAtPoleAxis } from "./util/lookAt";
export declare class Tracker<T extends Record<string, number | number[]>> {
    protected readonly points: T;
    private readonly debugConnections?;
    private objectGhost;
    readonly root: THREE.Object3D;
    /**
     * per landmark index, it points to it's object3D equivalent.
     */
    protected marks: {
        [name in keyof T]: Mark;
    };
    constructor(points: T, debugConnections?: {
        start: number;
        end: number;
    }[]);
    protected updateLandmarks(landmarks: Landmark[], debugLandmarks?: NormalizedLandmark[], debugDrawer?: DrawingUtils): void;
    protected getGhost(object: THREE.Object3D): Ghost;
    predict(source: TexImageSource, drawingUtils: DrawingUtils): void;
    sync(delta: number, objects: [THREE.Object3D, keyof T, keyof T, LookAtPoleAxis][]): void;
    test(key: keyof T): void;
    protected syncObjects(objects: [THREE.Object3D, keyof T, keyof T, LookAtPoleAxis][], delta: number, normal: THREE.Vector3): void;
    protected getBone(rig: THREE.Object3D, name: string): any;
}
declare class Mark extends THREE.Mesh {
    private _worldPosition;
    constructor();
    get worldPosition(): any;
}
declare class Ghost extends THREE.Object3D {
    lerp(target: THREE.Object3D, delta: number, speed?: number): void;
}
export {};
