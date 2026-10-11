/** Shared by AI submission, local scheduling and the deployed Cloudflare pool. */
export const DEFAULT_BLENDER_LIMITS: Readonly<{ global: number; owner: number; queued: number }> = Object.freeze({ global: 100, owner: 10, queued: 100 });
export const DEFAULT_BLENDER_CONCURRENCY = 1;
