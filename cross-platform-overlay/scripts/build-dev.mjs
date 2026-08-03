#!/usr/bin/env node
// Builds a DEV-CHANNEL overlay that replaces an existing local dev install in
// place — the gap that made `dist:linux` silently install a PRODUCTION build over
// a dev one (issue #428).
//
// Why neither existing script does this:
//
//   dist:linux / dist:win / dist:mac
//     No fcmChannel, so main.js resolves BUILD_CHANNEL='stable' and the app talks
//     to the PRODUCTION relay. Installed over a dev install it looks healthy, but
//     the stored dev session is rejected and you land on a login wall that can
//     never reach dev chat.
//
//   dist:qa
//     Correct relay, but it forces productName="Fallout Chat Mod QA". productName
//     feeds app.getPath('userData') (main.js deliberately never calls
//     app.setName()), so the app moves to ~/.config/Fallout Chat Mod QA and leaves
//     your session, keybinds and window bounds behind. It also auto-stamps
//     <base>-qa.<timestamp>, which the dev backend's golden-build lock
//     (QA_ACTIVE_VERSION) rejects until blessed.
//
// This script: fcmChannel=qa (→ dev relay), productName UNCHANGED (→ same
// userData), and the version pinned to package.json's own version so it matches
// an already-blessed lock. Exactly what you want for "rebuild my local dev
// overlay to test a change".
//
// Usage:  npm run dist:dev            (current platform)
//         npm run dist:dev -- --win   (any electron-builder flags pass through)

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.env.FCM_BUILD_VERSION || pkg.version;

// Anything after `--` is forwarded to electron-builder (e.g. --win, --linux).
const passthrough = process.argv.slice(2).join(' ');

console.log(`[dist:dev] building DEV-channel v${version} (relay: dev.falloutchatmod.com, userData preserved)`);

const env = { ...process.env, BUILD_CHANNEL: 'qa', FCM_BUILD_VERSION: version };
const eb = path.join(root, 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');

execSync('npm run build:renderer', { stdio: 'inherit', cwd: root, env });
execSync(
  `"${eb}" ${passthrough} -c.extraMetadata.fcmChannel=qa -c.extraMetadata.version=${version}`,
  { stdio: 'inherit', cwd: root, env },
);

console.log('\n[dist:dev] done. Verify BEFORE installing:');
console.log('  node -e \'const a=require("@electron/asar");const d=JSON.parse(a.extractFile("dist-electron/linux-unpacked/resources/app.asar","package.json"));console.log(d.productName,d.version,d.fcmChannel)\'');
console.log('  Expect: "Fallout Chat Mod" <version> qa   — productName MUST NOT say "QA".');
