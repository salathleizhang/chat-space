import { MCapClip, RecordedClip } from "./types";
export type AudioSpriteAtlas = {
    blob: Blob;
    sprites: ([start: number, duration: number] | undefined)[];
};
/**
 * Will complete the missing audio element on the clips by extracting the audio clip from the atlas.
 *
 * @param audioFile The audio file to extract sprites from.
 * @param clips The clips to extract sprites for.
 * @returns An array of audio elements, one for each clip ( undefined if no audio sprite is defined for that clip)
 */
export declare function extractAudioSprites(audioFile: File | Blob | string | ArrayBuffer, clips: RecordedClip[]): Promise<AudioSpriteAtlas>;
export declare function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer;
export type AudioAtlasPlayer = {
    stopCurrent: () => void;
    playSprite: (clipIndex: number) => AudioBufferSourceNode | undefined;
    setVolume: (value: number) => void;
};
/**
 * Creates a player that can play the audio sprites of the clips.
 * @param audioBuffer The audio buffer that contains the audio for the clips.
 * @param clips The meshcap clips
 * @returns A player that can play the audio sprites of the clips.
 */
export declare function createAudioAtlasPlayer(audioBuffer: AudioBuffer, clips: MCapClip[]): AudioAtlasPlayer;
