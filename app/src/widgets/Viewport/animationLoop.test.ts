import { expect, test } from "bun:test";
import * as THREE from "three";
import { needsAnimationFrame } from "./animationLoop";

/**
 * 这一组测的**不是**我们自己的分支，而是我们依赖的 three 行为——续帧判据之所以成立，
 * 全靠"播完之后 `isRunning()` 会变成 false"。所以它是回归网：three 升级后如果这条变了，
 * 这里先红，而不是等到用户发现风扇一直转。
 */
function scratch(duration = 1) {
  const root = new THREE.Object3D();
  const mixer = new THREE.AnimationMixer(root);
  const track = new THREE.VectorKeyframeTrack(".position", [0, duration], [0, 0, 0, 1, 1, 1]);
  const clip = new THREE.AnimationClip("clip", duration, [track]);
  return { mixer, action: mixer.clipAction(clip) };
}

test("nothing playing means no frame is requested", () => {
  expect(needsAnimationFrame([])).toBe(false);
  expect(needsAnimationFrame([undefined])).toBe(false);
  const { action } = scratch();
  expect(action.isRunning()).toBe(false);
  expect(needsAnimationFrame([action])).toBe(false);
});

test("a looping clip keeps asking for frames", () => {
  const { mixer, action } = scratch();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.reset().play();
  expect(needsAnimationFrame([action])).toBe(true);
  mixer.update(0.5);
  expect(needsAnimationFrame([action])).toBe(true);
  mixer.update(120); // 循环片段跨过很多圈也不该停
  expect(needsAnimationFrame([action])).toBe(true);
});

test("a LoopOnce clip stops asking for frames once it finishes", () => {
  const { mixer, action } = scratch();
  action.setLoop(THREE.LoopOnce, 1);
  action.reset().play();
  expect(needsAnimationFrame([action])).toBe(true);
  mixer.update(2); // 跨过整段
  expect(action.isRunning()).toBe(false);
  expect(needsAnimationFrame([action])).toBe(false);
});

test("clampWhenFinished keeps the last pose without asking for more frames", () => {
  const { mixer, action } = scratch();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.reset().play();
  mixer.update(2);
  expect(action.paused).toBe(true);
  expect(needsAnimationFrame([action])).toBe(false);
});

test("a stopped or frozen clip does not hold the render loop open", () => {
  const { action } = scratch();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.reset().play();
  action.stop();
  expect(needsAnimationFrame([action])).toBe(false);

  const frozen = scratch().action;
  frozen.setLoop(THREE.LoopRepeat, Infinity);
  frozen.reset().play();
  frozen.timeScale = 0;
  expect(needsAnimationFrame([frozen])).toBe(false);
});

test("any one advancing clip is enough", () => {
  const first = scratch();
  const second = scratch();
  first.action.setLoop(THREE.LoopOnce, 1);
  first.action.reset().play();
  first.mixer.update(2);
  second.action.setLoop(THREE.LoopRepeat, Infinity);
  second.action.reset().play();
  expect(needsAnimationFrame([first.action, second.action])).toBe(true);
});
