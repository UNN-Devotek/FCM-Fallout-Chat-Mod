# Windows NSIS CI Build — Fix History

This document records every failure and fix applied to get the
`overlay-autoupdate-e2e-windows` CI job passing. It exists as context
for future AI sessions or humans debugging the same job.

## Setup overview

The job builds a Windows NSIS installer entirely on Linux using DinD
(Docker-in-Docker). The strategy is:

1. Start a `ghcr.io/unn-corp/win-electron-builder:latest` container
   (`sleep infinity`).
2. `docker cp` the workspace into `/workspace/` inside the container.
3. `docker exec` a shell script (`win-build-inner.sh`) that runs the
   full build inside the container.
4. `docker cp` the resulting `dist-electron/` back out.
5. A separate **Smoke-test** step uses the same container to run the
   installer via Wine and verify it launches.

The image provides Wine + NSIS + electron-builder but has **64-bit Wine
only** (no `wine32` / no WOW64 support out of the box).

---

## Fixes applied (in order)

### 1. Stale Xvfb lock — `rm -f /tmp/.X99-lock`

Wine requires a display. The inner script starts `Xvfb :99`. On a
runner that had crashed or been reused, `/tmp/.X99-lock` was left
behind, preventing Xvfb from starting.

**Fix:** `rm -f /tmp/.X99-lock` before launching Xvfb.

---

### 2. `rcedit-ia32.exe` fails — exit status 123

electron-builder uses `rcedit` to stamp PE metadata (app name, icon,
version) into the Electron binary. It tries `rcedit-ia32.exe` first.
Since Wine is 64-bit only, running a 32-bit PE exits 123.

**Fix:** Pre-fetch the `winCodeSign` bundle, extract it to the path
electron-builder expects, then copy `rcedit-x64.exe` over
`rcedit-ia32.exe`:

```bash
WCSIGN_VER="2.6.0"
WCSIGN_DIR="/root/.cache/electron-builder/winCodeSign/winCodeSign-${WCSIGN_VER}"
if [ ! -d "$WCSIGN_DIR" ]; then
  curl -sL "https://github.com/electron-userland/electron-builder-binaries/releases/\
download/winCodeSign-${WCSIGN_VER}/winCodeSign-${WCSIGN_VER}.7z" -o /tmp/wcsign.7z
  7z x /tmp/wcsign.7z -o"$WCSIGN_DIR/" -y
fi
cp "$WCSIGN_DIR/rcedit-x64.exe" "$WCSIGN_DIR/rcedit-ia32.exe"
```

**Critical:** the `-o` path must include the versioned subdirectory
(`winCodeSign-2.6.0/`). Without it, files land one level too high and
the `cp` fails with "No such file".

---

### 3. `7z: command not found`

The extraction above requires `p7zip-full`. The container doesn't have
it preinstalled.

**Fix:** install it conditionally:

```bash
if ! command -v 7z >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends p7zip-full
fi
```

Note: `apt-get update` is no longer needed here separately because the
`wine32` install step (fix #5) always runs `apt-get update` first.

---

### 4. `apt-get` returns exit code 100

An earlier version of fix #3 did `command -v 7z || apt-get install ...`
with `>/dev/null 2>&1` suppressing output. `apt-get` returns **100**
when the package index is stale or a package isn't found — different
from the usual non-zero. The suppressed error caused a silent failure.

**Fix:** use `if ! command -v 7z; then ... fi` (no output suppression)
and run `apt-get update` when needed so the index is fresh.

---

### 5. NSIS installer stub fails — exit status 123

After the NSIS installer is built, electron-builder runs it via Wine as
part of its build process (the `portable` target reads files out of the
NSIS installer; even building only the `nsis` target triggers this
internally). NSIS installer stubs are **always 32-bit PE**. In a
wine64-only environment they exit 123.

Replacing `win-build` with `./node_modules/.bin/electron-builder`
directly did **not** help — the Wine call comes from electron-builder
itself, not the `win-build` wrapper.

**Fix:** install `wine32` **before** `wineboot --init` so the Wine
prefix is created as WOW64 (supports both 32-bit and 64-bit PE):

```bash
dpkg --add-architecture i386
apt-get update -qq
apt-get install -y --no-install-recommends wine32
wineboot --init 2>/dev/null || true
```

Installing `wine32` **after** `wineboot --init` does not work reliably
because the prefix is already created as win64-only.

---

### 6. `No such container` in smoke-test step

The build step had `trap "docker rm -f $CID 2>/dev/null || true" EXIT`.
In GitHub Actions, each step runs in its own shell subprocess. When the
build step's shell exited (successfully), the trap fired and removed the
container — before the separate **Smoke-test** step could use `$CID`.

**Fix:** remove the trap from the build step. Add it to the smoke-test
step instead, which already owns the container's cleanup:

```yaml
- name: Smoke-test Windows binary via Wine
  run: |
    trap "docker rm -f \"$CID\" 2>/dev/null || true" EXIT
    ...
```

The DinD daemon is scoped to the job, so any container that leaks due
to a failed build is disposed of automatically when the job ends.

---

### 7. Running the packaged `.exe` under Wine fails — `STATUS_BREAKPOINT` (0x80000003)

After fixing the build, the Wine execution step crashed immediately with:
```
wine: Unhandled exception 0x80000003 in thread f4 at address 000000014429D633
```

`STATUS_BREAKPOINT` is an `int 3` instruction in Electron 31's Chromium startup code
(crash-reporter / Crashpad init). On real Windows, Electron's own VEH catches it and
calls `CONTINUE_EXECUTION`. Under Wine, the JIT debugger (AeDebug) intercepts the
exception **before** the app's VEH runs — a Wine exception-dispatch ordering difference
— so the process terminates instead of continuing.

Attempts made (all failed):
- `winedbg --auto %ld %ld` as AeDebug debugger — reduced hang from 62 s to instant exit (code 3)
- NOP-patching the `int 3` byte — wrong offset: PE RVA ≠ file offset; byte at that
  position was `0x66`, not `0xCC`

**Root cause conclusion:** Running a packaged Electron 31+ `.exe` under Wine is not a
supported pattern. electron-builder's own test suite runs Windows tests on real Windows
runners and explicitly documents that Wine "is not capable of installing or running
Windows executables." There is no known Wine configuration that makes this work for
Electron 31+.

**Resolution:** The Wine execution step was removed. The `overlay-autoupdate-e2e-windows`
job now ends with a static artifact verification step (`tests/mock-relay/win-artifacts-check.mjs`)
that checks build correctness without running the exe. The Linux E2E job (`overlay-e2e-linux`) already exercises the `electron-updater` code path
end-to-end. If a Windows runner is available, `overlay-autoupdate-e2e-windows-exec` covers
real native execution as bonus coverage (`continue-on-error: true`).

---

## Final working state (inner build script structure)

```
1. Start Xvfb :99 (rm stale lock first)
2. dpkg --add-architecture i386
   apt-get update -qq
   apt-get install wine32          ← must be before wineboot
3. wineboot --init
4. Install p7zip-full if missing
5. Download + extract winCodeSign-2.6.0 to versioned subdir
   cp rcedit-x64.exe → rcedit-ia32.exe
6. cd /workspace/admin-dashboard && npm ci
7. cd /workspace/cross-platform-overlay && npm install --ignore-scripts
8. CSC_IDENTITY_AUTO_DISCOVERY=false \
     ./node_modules/.bin/electron-builder --win nsis --publish=never
```

The build step traps `docker rm -f $CID` on EXIT (cleanup on build failure), then
`docker cp`s `dist-electron/` back to the runner workspace. The next step runs
`tests/mock-relay/win-artifacts-check.mjs` on the runner host to verify the artifacts.

---

## Migration to native `windows-latest` (GitHub-hosted runner migration)

The entire Wine/DinD/docker-cp strategy described above was **superseded** when the CI pipeline
migrated to GitHub-hosted runners as the default.

The `overlay-autoupdate-e2e-windows` CI job now builds the NSIS installer **natively on
`windows-latest`** (GitHub Actions hosted runner). There is no longer any Wine, Docker, or
`ghcr.io/unn-corp/win-electron-builder` image involvement in CI.

The private GHCR image (`ghcr.io/unn-corp/win-electron-builder`) has no current CI role.
The seven Wine/DinD fixes documented above are retained here for historical context — they explain
why the migration away from Wine was necessary and what was attempted before giving up on the
Wine execution path.

**Why native windows-latest supersedes the prior strategy:**
- No Wine `STATUS_BREAKPOINT` crash — builds and runs real Windows PE binaries natively.
- No Docker-in-Docker complexity (DinD service, `DOCKER_HOST`, `DOCKER_CERT_PATH`, `docker cp`).
- No GHCR image pull (private registry, credentials, image maintenance burden).
- Simpler job definition; timeout reduced from 15 min to 30 min (worst-case; typical is faster).

**Runner toggle:** the job uses `vars.CI_RUNNER_WINDOWS && fromJSON(vars.CI_RUNNER_WINDOWS) || 'windows-latest'`,
so setting the `CI_RUNNER_WINDOWS` repo variable to `["self-hosted","windows","unn"]` reverts to
a self-hosted Windows runner without any job changes.

**Release workflows** (`build-windows.yml`) continue to use the self-hosted
`[self-hosted, windows, unn]` runner by design — they are NOT affected by the CI runner migration.
