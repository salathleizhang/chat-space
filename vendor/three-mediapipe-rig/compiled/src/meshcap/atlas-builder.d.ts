import { MeshCapAtlas, RecordedClip } from "./types";
/**
 * Builds a texture atlas from a list of recorded clips.
 * @param clips The clips to build the atlas from
 * @param atlasSize Max size of the atlas (width or height)
 * @param padding The padding to add between frames
 * @returns The atlas
 */
export declare function buildMeshCapAtlas(clips: RecordedClip[], atlasSize: number, padding?: number): MeshCapAtlas;
/**
 * Load an atlas from a URL or File. If will handle deobfuscation if the file is an .mcapatlas file.
 * @param atlasSource URL or File of the atlas. If it is an .mcapatlas file, it will be deobfuscated.
 * @param pass If the atlas is obfuscated, provide the passphrase to deobfuscate it.
 * @returns
 */
export declare function loadMeshcapAtlas(atlasSource: string | File, pass?: string): Promise<any>;
export declare function obfuscateImage(image: HTMLImageElement, pass: string): Promise<Blob>;
