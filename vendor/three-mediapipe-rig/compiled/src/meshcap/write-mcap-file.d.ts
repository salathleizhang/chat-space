import { MeshCapAtlas } from "./types";
/**
 * generates an .mcap binary from the atlas
 * @param atlas
 * @param useRelativeLandmarks Used internally to save space.
 * @returns
 */
export declare function atlasToMCap(atlas: MeshCapAtlas, useRelativeLandmarks?: boolean): Promise<Blob>;
/**
 * generates an .mcap array buffer. Used for simulating ( in the meshcap editor ) opening the file in a real life situation
 * @param atlas
 * @param useRelativeLandmarks Used internally to save space.
 * @returns
 */
export declare function atlasToMCapBuffer(atlas: MeshCapAtlas, useRelativeLandmarks?: boolean): Promise<ArrayBuffer>;
