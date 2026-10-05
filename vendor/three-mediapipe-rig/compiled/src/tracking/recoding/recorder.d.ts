import * as THREE from "../../../../../../app/node_modules/@types/three/index.js";
import { BoneMap } from "../BoneMapping";
type Recorder = {
    start: (fps?: number) => void;
    captureFrame: () => void;
    stop: (name?: string) => {
        clip: THREE.AnimationClip;
        saveToFile: () => void;
    };
    isRecording: () => boolean;
};
/**
 * Records the local rotation of the bones in the rig. The name used will be the normalized bone name.
 * @param rigRoot
 * @param magging
 * @param fps
 * @returns
 */
export declare function createRigRecorder(rigRoot: THREE.Object3D, magging: BoneMap, fps?: number): Recorder;
export {};
