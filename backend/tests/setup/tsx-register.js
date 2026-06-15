'use strict';
// Register tsx's CJS hook so Jest can require() TypeScript source files directly.
// This patches Node's module system to compile .ts on the fly — same mechanism
// as `tsx` CLI and `--import tsx` but available as a synchronous CJS setup.
require('tsx/cjs');
