import { DrawingUtils, PoseLandmarker } from "../../../../../app/node_modules/@mediapipe/tasks-vision/vision";
import * as THREE from "../../../../../app/node_modules/@types/three/build/three.webgpu.js";
import { Tracker } from "./Tracker";
import { BoneMap } from "./BoneMapping";
export declare function loadPoseTracker(vision: any, config?: Partial<PoseTrackerConfig>): Promise<PoseTracker>;
/**
 * Points derived from https://ai.google.dev/static/mediapipe/images/solutions/pose_landmarks_index.png
 * If the array has 2 elements, the point is between those 2 landmarks.
 * If it has 4, the point is at the center of those 4 landmarks.
 */
declare const poseMarks: {
    hips: number[];
    neck: number[];
    leftLeg: number;
    leftKnee: number;
    leftFoot: number;
    leftToes: number;
    leftArm: number;
    leftElbow: number;
    leftWrist: number;
    rightLeg: number;
    rightKnee: number;
    rightFoot: number;
    rightToes: number;
    rightArm: number;
    rightElbow: number;
    rightWrist: number;
    head: number[];
    forehead: number[];
    mouth: number[];
    torso: number[];
    leftEar: number;
    rightEar: number;
    nose: number;
};
type PoseTrackerConfig = {
    ignoreLegs: boolean;
    modelPath: string;
    drawLandmarks?: boolean;
};
/**
 * @see https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 */
export declare class PoseTracker extends Tracker<typeof poseMarks> {
    private readonly poseLandmarker;
    private readonly config?;
    private _leftWristNormalizedPosition;
    private _rightWristNormalizedPosition;
    ignoreLegs: boolean;
    /**
     * Position of the left wrist in normalized coordinates (0..1)
     */
    get leftWristNormalizedPosition(): NormalizedLandmark;
    /**
     * Position of the right wrist in normalized coordinates (0..1)
     */
    get rightWristNormalizedPosition(): NormalizedLandmark;
    constructor(poseLandmarker: PoseLandmarker, config?: Partial<PoseTrackerConfig>);
    predict(source: TexImageSource, drawingUtils: DrawingUtils): void;
    bind(rig: THREE.Object3D, magging: BoneMap): {
        update: (delta: number) => void;
    };
}
export {};
