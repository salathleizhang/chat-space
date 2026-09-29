# Pinned WebGPU lifecycle fixes

These local patches are applied by Bun through root `patchedDependencies`.
Keep the dependency versions pinned and run the browser stress test when upgrading.
They change disposal, not rendering, projection, sorting or output quality.

## Three.js 0.186.1

`Attributes.update()` did not subscribe to `BufferAttribute`'s `dispose` event.
Compute-only storage/indirect attributes are not owned by a `BufferGeometry`,
so disposing GSL's sort/projection buffers did not destroy their GPU allocations.
Subscribe on allocation and unsubscribe on deletion (including geometry-driven
deletion), but only when the attribute is an `EventDispatcher`: `Geometries`
also hands interleaved attributes to the same code path, and
`InterleavedBufferAttribute` has no `addEventListener`. The unguarded call threw
`Uncaught TypeError: attribute.addEventListener is not a function` from
`Geometries.updateAttributes` on every model-preview cycle (confirmed in the
browser, 2026-09-29). Unsubscribe through the same guard so the paths stay
symmetric. Patch source and both distributed WebGPU entry points. The regression
test is `app/src/shared/rendering/attributeDisposal.test.ts`.

## Gaussian Splat Lite 1.1.5

`textureBinding()` allocates unique integer texture placeholders during shader
compilation. These were not released by renderer disposal. Keep a weak ownership
map keyed by uniforms and release placeholders when their material or compiled
projection slot is disposed. Do not share placeholders: their identities keep
dynamic texture bindings distinct. Patch the ESM and CJS distributions.

The original Apache-2.0 license and NOTICE remain in
`app/public/licenses/gaussian-splat-lite/`. This file records our modifications;
they are not claimed to be upstream fixes.
