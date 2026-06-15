'use strict';
// Minimal Jest transformer: strips TypeScript annotations via esbuild
// (already installed as a tsx dependency). Used so tests can require()
// src/*.ts files directly without a full ts-jest setup.
const esbuild = require('esbuild');

module.exports = {
  process(src, filename) {
    const result = esbuild.transformSync(src, {
      loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
      target: 'node18',
      format: 'cjs',
      sourcemap: 'inline',
      sourcefile: filename,
    });
    return { code: result.code };
  },
};
