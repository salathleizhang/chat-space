import { describe, expect, test } from "bun:test";
import { RenderSchedule } from "./RenderSchedule";

describe("project render schedule", () => {
  test("each scene and its HUD draw atomically, in registration order", () => {
    const schedule = new RenderSchedule();
    const calls: string[] = [];
    schedule.register("top", "hud", () => { calls.push("top hud"); });
    schedule.register("persp", "scene", (delta) => { calls.push(`persp ${delta}`); return true; });
    schedule.register("top", "scene", (delta) => { calls.push(`top ${delta}`); return true; });
    schedule.register("persp", "hud", () => { calls.push("persp hud"); });
    schedule.draw(0.016);
    expect(calls).toEqual(["top 0.016", "top hud", "persp 0.016", "persp hud"]);
  });

  test("hidden or unmounted scenes do not draw their HUD", () => {
    const schedule = new RenderSchedule();
    let draws = 0;
    schedule.register("hidden", "scene", () => false);
    schedule.register("hidden", "hud", () => { draws++; });
    schedule.register("unmounted", "hud", () => { draws++; });
    schedule.draw(1);
    expect(draws).toBe(0);
  });

  test("StrictMode cleanup cannot unregister a replacement callback", () => {
    const schedule = new RenderSchedule();
    let draws = 0;
    const old = schedule.register("view", "scene", () => true);
    const next = schedule.register("view", "scene", () => { draws++; return true; });
    old();
    schedule.draw(1);
    expect(draws).toBe(1);
    next();
    expect(schedule.size).toBe(0);
    const replacement = schedule.register("view", "scene", () => true);
    old(); next();
    expect(schedule.size).toBe(1);
    replacement();
    expect(schedule.size).toBe(0);
  });
});
