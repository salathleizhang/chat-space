import { expect, test } from "bun:test";
import { renderHook } from "../../test-utils";
import { useCaptureResult } from "./useCaptureResult";

test("capture completion settles once and ignores an obsolete resource generation", async () => {
  const calls: string[] = [];
  const hook = await renderHook(({ key }: { key: string }) => useCaptureResult(key, (value: string) => { calls.push(value); }), { key: "v1" });
  const old = hook.result.current;
  old("success"); old("device lost");
  expect(calls).toEqual(["success"]);
  await hook.rerender({ key: "v2" });
  old("late old image");
  hook.result.current("new image");
  expect(calls).toEqual(["success", "new image"]);
  await hook.unmount();
});
