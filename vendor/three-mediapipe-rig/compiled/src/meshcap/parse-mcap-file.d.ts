import { MCapFile, MeshCapAtlas } from "./types";
/**
 * Loads a MeshCap (.mcap) file from a URL or File object. This is the file that contains the metadata for the clips.
 * @param mcapFileSource URL or File object
 * @returns
 */
export declare function loadMeshCapFile(mcapFileSource: string | File): Promise<MCapFile>;
export declare function readAsMCapFile(atlas: MeshCapAtlas): Promise<MCapFile>;
