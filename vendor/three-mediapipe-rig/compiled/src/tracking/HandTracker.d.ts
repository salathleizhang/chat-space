import { DrawingUtils, HandLandmarker, HandLandmarkerOptions, NormalizedLandmark } from "../../../../../app/node_modules/@mediapipe/tasks-vision/vision";
import * as THREE from "../../../../../app/node_modules/@types/three/build/three.webgpu.js";
import { LookAtPoleAxis } from "./util/lookAt";
import { Tracker } from "./Tracker";
import { BoneMap } from "./BoneMapping";
export type HandsTrackerConfig = {
    leftWrist: () => NormalizedLandmark;
    rightWrist: () => NormalizedLandmark;
    modelPath?: string;
    drawLandmarks?: boolean;
} & Partial<HandLandmarkerOptions>;
export declare function loadHandTracker(vision: any, config: HandsTrackerConfig): Promise<{
    readonly left: HandsTracker;
    readonly right: HandsTracker;
}>;
declare const handMarks: {
    wrist: number;
    palm: number[];
    thumb1: number;
    thumb2: number;
    thumb3: number;
    thumb4: number;
    index1: number;
    index2: number;
    index3: number;
    index4: number;
    middle1: number;
    middle2: number;
    middle3: number;
    middle4: number;
    ring1: number;
    ring2: number;
    ring3: number;
    ring4: number;
    pinky1: number;
    pinky2: number;
    pinky3: number;
    pinky4: number;
};
export type HandMarkName = keyof typeof handMarks;
type HandSide = "Left" | "Right";
export type Mark2Bone = Partial<{
    [key in HandMarkName]: THREE.Object3D;
}>;
export declare class HandsTracker extends Tracker<typeof handMarks> {
    private readonly handLandmarker;
    private readonly side;
    private readonly isMyWrist;
    private drawLandmarks;
    /** Editor integration: permit tracking every orientation; upstream default stays unchanged. */
    allowAllDirections: boolean;
    private readonly sign;
    private readonly isLeft;
    /**
     * the axis used to look at the pole
     */
    private readonly lookAtPoleAxis;
    constructor(handLandmarker: HandLandmarker, side: HandSide, isMyWrist: (handWrist: NormalizedLandmark) => boolean, drawLandmarks?: boolean);
    predict(source: TexImageSource, drawingUtils: DrawingUtils): void;
    sync(delta: number, objects: [THREE.Object3D, HandMarkName, HandMarkName, LookAtPoleAxis][]): void;
    /**
     *
     * @param delta time since last frame
     * @param landmark2bones Array the same size as the umber of hand landmarks, and on each positionthe bone that belongs to that point.
     * @see https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
     */
    syncHandBones(delta: number, markToBone: Mark2Bone, rig: THREE.Object3D): void;
    private syncFinger;
    bind(rig: THREE.Object3D, magging: BoneMap): {
        update: (delta: number) => void;
    };
}
export {};
