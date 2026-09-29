import { expect, test } from "bun:test";
import { InterleavedBuffer, InterleavedBufferAttribute, StorageBufferAttribute } from "three/webgpu";
// @ts-expect-error Pinned private module has no declaration; verifies our dependency patch.
import Attributes from "three/src/renderers/common/Attributes.js";

test("compute-only storage attributes release GPU allocations when disposed", () => {
  let created = 0, destroyed = 0, counted = 0;
  const backend = { createStorageAttribute: () => { created++; }, destroyAttribute: () => { destroyed++; } };
  const info = { createStorageAttribute: () => { counted++; }, destroyAttribute: () => { counted--; } };
  const attributes = new Attributes(backend, info);
  const attribute = new StorageBufferAttribute(16, 1);
  // AttributeType.STORAGE in the pinned renderer.
  attributes.update(attribute, 3);
  expect(created).toBe(1);
  attribute.dispose(); attribute.dispose();
  expect(destroyed).toBe(1); expect(counted).toBe(0);
  // A later upload creates a new lease, with only one disposal listener.
  attributes.update(attribute, 3);
  attributes.delete(attribute);
  attribute.dispose();
  expect(created).toBe(2); expect(destroyed).toBe(2); expect(counted).toBe(0);
});

/**
 * `InterleavedBufferAttribute` is not an `EventDispatcher`, yet `Geometries`
 * hands interleaved attributes to the very same `update()` path. The first
 * version of the patch called `addEventListener` unconditionally and threw
 * "attribute.addEventListener is not a function" from
 * `Geometries.updateAttributes` on every model-preview cycle (confirmed in the
 * browser on 2026-09-29). Registering and deleting a non-dispatchable attribute
 * must be no-ops instead of throwing.
 */
test("interleaved attributes without an EventDispatcher neither throw nor leak", () => {
  let created = 0, destroyed = 0, counted = 0, updated = 0;
  const backend = { createAttribute: () => { created++; }, updateAttribute: () => { updated++; }, destroyAttribute: () => { destroyed++; } };
  const info = { createAttribute: () => { counted++; }, destroyAttribute: () => { counted--; } };
  const attributes = new Attributes(backend, info);
  const buffer = new InterleavedBuffer(new Float32Array(12), 3);
  const attribute = new InterleavedBufferAttribute(buffer, 3, 0);
  expect(typeof (attribute as unknown as { addEventListener?: unknown }).addEventListener).toBe("undefined");
  // AttributeType.VERTEX (1) in the pinned renderer.
  expect(() => attributes.update(attribute, 1)).not.toThrow();
  expect(created).toBe(1);
  // A newer version of the shared interleaved buffer reuses the same lease.
  buffer.version++;
  expect(() => attributes.update(attribute, 1)).not.toThrow();
  expect(created).toBe(1); expect(updated).toBe(1);
  expect(() => attributes.delete(attribute)).not.toThrow();
  expect(destroyed).toBe(1); expect(counted).toBe(0);
});
