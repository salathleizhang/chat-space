export * from "./src/module";
export { defaultBoneMap } from "./src/tracking/BoneMapping";
export { HandsTracker, loadHandTracker } from "./src/tracking/HandTracker";
export { PoseTracker, loadPoseTracker } from "./src/tracking/PoseTracker";
export { FaceTracker, loadFaceTracker } from "./src/tracking/FaceTracker";
import { type Landmark } from "../../../app/node_modules/@mediapipe/tasks-vision/vision";
import { HandsTracker } from "./src/tracking/HandTracker";
/** Feed already identified hands into the complete upstream tracking/binding class. */
export declare class EditorHandsTracker extends HandsTracker {
    constructor(side: "Left" | "Right");
    acceptLandmarks(landmarks: Landmark[]): void;
    predict(): never;
}
