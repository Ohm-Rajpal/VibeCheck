"use strict";
// Shared TypeScript interfaces for VibeCheck.
// Mirrored on the Python side in packages/api/db/schema.py.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sharedReferenceProbe = sharedReferenceProbe;
// Temporary probe to validate ts-morph cross-root reference resolution.
function sharedReferenceProbe(seed) {
    return `probe:${seed}`;
}
//# sourceMappingURL=types.js.map