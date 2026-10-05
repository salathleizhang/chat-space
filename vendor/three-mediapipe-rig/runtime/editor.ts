// Integration boundary only: no palm/finger rotations or bind-pose calibration.
export * from "./src/module";
export { defaultBoneMap } from "./src/tracking/BoneMapping";
export { HandsTracker, loadHandTracker } from "./src/tracking/HandTracker";
export { PoseTracker, loadPoseTracker } from "./src/tracking/PoseTracker";
export { FaceTracker, loadFaceTracker } from "./src/tracking/FaceTracker";
import { HandLandmarker, type Landmark } from "@mediapipe/tasks-vision";
import { HandsTracker } from "./src/tracking/HandTracker";

/** Feed already identified hands into the complete upstream tracking/binding class. */
export class EditorHandsTracker extends HandsTracker {
  constructor(side: "Left" | "Right") {
    // Detection is owned by the editor's camera lifecycle. This tracker only
    // consumes results; never call its inherited predict() with this sentinel.
    super(null as unknown as HandLandmarker, side, () => false, false);
    this.allowAllDirections = true;
  }

  acceptLandmarks(landmarks: Landmark[]): void {
    this.updateLandmarks(landmarks);
  }

  override predict(): never {
    throw new Error("EditorHandsTracker accepts existing detector results through acceptLandmarks()");
  }
}
