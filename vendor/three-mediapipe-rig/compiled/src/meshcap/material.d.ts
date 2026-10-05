import { Mesh, Texture } from "../../../../../app/node_modules/@types/three/index.js";
import { MCapClip } from "./types";
import { Matrix4, NodeMaterial } from "../../../../../app/node_modules/@types/three/build/three.webgpu.js";
export type MeshCapMaterialHandler = {
    /**
     * 4x4 transformation matrix from MediaPipe Face tracking.
     * Represents the face pose in camera space (position, rotation, scale).
     * Can be applied directly to 3D objects to align them with the tracked face.
     *
     * Returns the last known face transform matrix.
     * Everytime you call `update` and the frames get evaluated, this will return the transformMatrix the face has in the
     * current frame. You can use this to position hats, hair, etc. Remember this transformation is from the face's origin perspective.
     * So if you do add a hat, make sure the origin point of it is at the same place as the origin point of the face mesh so the rotations look alright.
     * @returns
     */
    getLastKnownFaceTransform: () => Matrix4 | undefined;
    /**
     * If it should play a sound or not (if it has one. Default: false )
     */
    muted: boolean;
    /**
     * This hook will be called everytime a clip starts playing.
     * @param clipIndex Index of the clip that is starting to play
     * @param clipStartTime Start time of sound clip withing the sound atlas (in seconds)
     * @param clipDuration Duration of the clip (in seconds)
     * @returns
     */
    playClipAudioHook?: (clipIndex: number, clipStartTime: number, clipDuration: number) => void;
    /**
     * Moves to a particular clip
     * @param clipIndex The index of the clip to move to
     * @param _loop Optional: Whether the clip should loop
     * @param _onEndReached Optional: Callback to be called when the clip reaches the end
     */
    goto: (clipIndex: number | string, _loop?: boolean, _onEndOrLoopReached?: (timeOffset: number) => void, playSound?: boolean) => void;
    /**
     * Play a clip and when it reaches the end, it will loop back
     * @param clipName Name of the clip
     * @returns
     */
    gotoAndLoop: (clipIndex: number | string, _onLoop?: (timeOffset: number) => void) => void;
    /**
     * Play a clip and when it reaches the end, it will not loop back
     * @param clipName Name of the clip
     * @returns
     */
    gotoAndPlay: (clipIndex: number | string, _onEndReached?: () => void) => void;
    /**
     * Moves to a particular clip and stops at the first frame
     * @param clipIndex The index of the clip to move to
     * @returns
     */
    gotoAndStop: (clipIndex: number | string, frame?: number) => void;
    /**
     * Updates the material with the given delta time
     * @param delta The time to add to the current time
     */
    update: (delta: number) => void;
    /**
     * The clips available to play
     */
    clips: MCapClip[];
    /**
     * The texture atlas that contains the frames used by the clips
     */
    atlasTexture: Texture;
    /**
     * Disposes the material and the texture atlas
     */
    dispose: VoidFunction;
    /**
     * The material used
     */
    material: NodeMaterial;
};
/**
 * Creates or setups a MeshCap material handler (not the material itself) for a given mesh.
 *
 * @param atlasTexture The texture atlas that contains the frames used by the clips. You may need to `flipY=false` on the texture atlas.
 * @param clips The clips previously obtained by loading an .mcap file
 * @param targetMesh The mesh to apply the material to. (It will be updated with a landmarkIndex attribute if it doesn't have one)
 * @param host Optional: The material to use as a base. Defaults to a MeshPhysicalNodeMaterial.
 * @param audioAtlas Optional: The audio atlas that contains the audio for the clips if you want to let the handler play the audio clips automatically on it's own. Else you will have to hook on the `playClipAudioHook` callback from the returned handler and play them yourself.
 * @returns A handler that allows you to control the material.
 */
export declare function createMeshCapMaterial(atlasTexture: Texture, clips: MCapClip[], targetMesh: Mesh, host?: NodeMaterial, audioAtlas?: AudioBuffer): MeshCapMaterialHandler;
