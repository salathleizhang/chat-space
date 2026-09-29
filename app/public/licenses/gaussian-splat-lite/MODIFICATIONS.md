# ChatSpace modifications

ChatSpace uses Gaussian Splat Lite 1.1.5 with a local resource-lifecycle patch.
The ESM and CJS distributions track temporary shader-binding placeholder textures
by their uniform owner and release them when a material or projection slot is
disposed. Rendering and sorting algorithms are unchanged.

The patch is maintained in `patches/gaussian-splat-lite@1.1.5.patch` in the
ChatSpace source repository. It is not an upstream release or endorsement.
The original LICENSE, NOTICE and THIRD_PARTY_LICENSES.md are distributed alongside
this modification notice without changes.
