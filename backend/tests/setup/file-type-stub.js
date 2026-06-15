'use strict';
// Stub for the ESM-only `file-type` package so Jest (CJS) can load server.ts
// transitively without failing. Tests that need real MIME detection mock this
// directly; the production path only runs in the packaged server.
module.exports = {
  fileTypeFromBuffer: async () => undefined,
  fileTypeFromStream: async () => undefined,
};
