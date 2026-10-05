import { DrawingUtils, FaceLandmarker } from "../../../../../app/node_modules/@mediapipe/tasks-vision/vision";
import { Mesh, Object3D, Node } from "../../../../../app/node_modules/@types/three/build/three.webgpu.js";
import { Tracker } from "./Tracker";
export type FaceTrackerConfig = {
    modelPath?: string;
    videoElementRef?: () => HTMLVideoElement | undefined;
    drawLandmarks?: boolean;
};
export declare function loadFaceTracker(vision: any, cfg?: FaceTrackerConfig): Promise<FaceTracker>;
/**
 * @see https://storage.googleapis.com/mediapipe-assets/documentation/mediapipe_face_landmark_fullsize.png
 * @see https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
 */
declare const faceMarks: {
    eyeL: number;
    eyeR: number;
    eyeStartL: number;
    eyeStartR: number;
    eyeEndL: number;
    eyeEndR: number;
    earL: number;
    earR: number;
    noseTip: number;
    noseBone: number;
    chin: number;
    forehead: number;
};
export declare class FaceTracker extends Tracker<typeof faceMarks> {
    private faceLandmarker;
    private cfg;
    private blendshapeCategories;
    private blendshapeMap;
    private smoothed;
    private smoothing;
    private _faceLandmarks;
    private _facialTransformationMatrix;
    constructor(faceLandmarker: FaceLandmarker, cfg: FaceTrackerConfig);
    predict(frame: TexImageSource, drawingUtils: DrawingUtils): void;
    get lastKnownLandmarks(): NormalizedLandmark[];
    /**
     * this matrix is useful to know how the canonical mesh is rotated.
     * This allows to move other objects to simulate the same transformation that the skull/face is having.
     * Used for things like hats, glasses, etc... things you want to make look like they are attatched to the face mesh.
     */
    get lastKnownFacialTransformationMatrix(): any;
    bindShapeKeys(mesh: Mesh): {
        update: (delta: number) => void;
    };
    bind(rig: Object3D): {
        update: (delta: number) => void;
    };
    /**
     * The mesh is assumed to be a canonical_face_model because we will be manipulating it's vertices.
     *
     * @see https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/modules/face_geometry
     * @param mesh basically either the original or a clone of the canonical_face_model
     * @returns an object with a disposeMaterial method that should be called when the mesh is disposed of.
     */
    bindGeometry(mesh: Mesh, setupTheMaterialYourself?: (posNode: Node<"vec3">, colorNode: Node<"vec4">) => void): {
        /**
         * Disposes of the material and removes events listeners on the video element.
         */
        disposeMaterial: () => void;
        /**
         * asas
         * @param delta asas
         * @returns
         */
        update: (delta: number) => void;
    };
}
export {};
