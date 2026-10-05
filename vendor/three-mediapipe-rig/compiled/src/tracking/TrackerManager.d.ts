import { HandLandmarkerOptions } from "../../../../../app/node_modules/@mediapipe/tasks-vision/vision";
import * as THREE from "../../../../../app/node_modules/@types/three/build/three.webgpu.js";
import { PoseTracker } from "./PoseTracker";
import { HandsTracker } from "./HandTracker";
import { FaceTracker } from "./FaceTracker";
import { BoneMap } from "./BoneMapping";
import { createRigRecorder } from "./recoding/recorder";
export type TrackerConfig = {
    /**
     * Use an image file. Useful to test a particular pose.
     */
    debugFrame?: string;
    /**
     * Scale of the video display
     */
    displayScale: number;
    /**
     * If the body pose should ignore the legs
     */
    ignoreLegs: boolean;
    /**
     * Use a video file instead of the webcam
     */
    debugVideo?: string;
    /**
     * Don't track the face
     */
    ignoreFace: boolean;
    /**
     * Only track the face
     */
    onlyFace: boolean;
    /**
     * @see https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js#configuration_options
     */
    handsTrackerOptions: HandLandmarkerOptions | undefined;
    modelPaths?: {
        vision?: string;
        pose?: string;
        hand?: string;
        face?: string;
    };
    /**
     * Draw the wireframe landmarks on top of the source image/video? ( default to true )
     */
    drawLandmarksOverlay?: boolean;
};
export interface BindingHandler {
    /**
     * Updates the rig with the latest landmarks.
     * @param delta The time elapsed since the last frame in seconds.
     */
    update: (delta: number) => void;
}
export interface RecorderHandler {
    /**
     * Starts recording the rig's movement and active shape keys ( from media pipe ).
     * @param fps Frames per second to record at. If 0, it will record at the current frame rate.
     */
    startRecording: (fps?: number) => void;
    /**
     * Stops recording the rig's movement.
     * @returns A function that can be called to SAVE the recording to a file.
     */
    stopRecording: ReturnType<typeof createRigRecorder>['stop'];
    /**
     * Checks if the rig is currently recording.
     * @returns True if the rig is recording, false otherwise.
     */
    isRecording: () => boolean;
}
export interface RecordableBindingHandler extends BindingHandler, RecorderHandler {
}
export declare function setupTracker(config?: Partial<TrackerConfig>): Promise<TrackerHandler>;
export type VideoHandler = {
    stop: VoidFunction;
    getStream: () => MediaStream | undefined;
};
export type TrackerHandler = {
    poseTracker: PoseTracker | undefined;
    handsTracker: {
        left: HandsTracker;
        right: HandsTracker;
    } | undefined;
    faceTracker: FaceTracker | undefined;
    /**
     * Video element showing the webcam or video file
     */
    video: HTMLVideoElement | undefined;
    /**
     * Canvas where the debug landmarks are drawn
     */
    canvas: HTMLCanvasElement | undefined;
    /**
     * A div that contains the video and canvas used to display the landmarks stacked on top of each other.
     */
    domElement: HTMLDivElement | undefined;
    /**
     * Start the webcam feed. This must be initiated by a user triggered event ( a click on a button ) due to security reasons.
     */
    start: (withAudio?: boolean) => Promise<VideoHandler>;
    /**
     * Pauses the tracking.
     */
    pause: VoidFunction;
    /**
     * Resumes the tracking.
     */
    resume: VoidFunction;
    /**
     * Binds the bones of the rig to the landmarks provided by media pipe.
     * @param rig The rig that contains all the bones and skinned meshes of your character.
     * @param magging The bone mapping to use for the rig.
     */
    bind: (rig: THREE.Object3D, magging?: BoneMap) => RecordableBindingHandler;
    /**
     * Sets the source of the video used for the face tracking.
     * @param source
     */
    setVideoFromSource: (source: string | File) => void;
    /**
     * Starts the webcam feed.
     * @returns A function to stop the webcam feed.
     */
    setVideoFromWebcam: (withAudio?: boolean) => Promise<VideoHandler>;
};
