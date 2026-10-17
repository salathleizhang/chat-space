/** Session states where the cloud is doing something the user is watching. */
const LIVE_STATES = new Set(["queued", "allocating", "preparing", "ready", "saving", "cleaning", "pausing"]);

/** Watching progress: unchanged from the original cadence. */
export const BLENDER_ACTIVE_POLL_MS = 5_000;
/** Nothing is running: a new AI session still appears on its own, and the logo refreshes at once. */
export const BLENDER_IDLE_POLL_MS = 30_000;

/**
 * How long until the next session-list refresh, or `null` to not schedule one.
 *
 * This is a **display** cadence only. Task progress itself arrives through `useTaskPolling`
 * (the 1 Hz external clock) and the chat resume path, so slowing this down cannot strand work —
 * per AGENTS.md §二.15–16, correctness must not rest on a timer in this process.
 *
 * Why it is not simply 5 s any more: every poll costs the Blender service a Durable Object query,
 * and Durable Objects bill **rows read**. A hidden tab that keeps polling every 5 s overnight is
 * what exhausted the account's 5M rows-read/day on 2026-10-17 and took the whole service down
 * (`Exceeded allowed rows read in Durable Objects free tier`). A hidden tab shows nothing, so it
 * polls nothing; an idle project keeps a slow heartbeat instead of a fast one.
 */
export function blenderPollDelayMs(sessions: readonly { state: string }[], hidden: boolean): number | null {
  if (hidden) return null;
  return sessions.some((session) => LIVE_STATES.has(session.state)) ? BLENDER_ACTIVE_POLL_MS : BLENDER_IDLE_POLL_MS;
}
