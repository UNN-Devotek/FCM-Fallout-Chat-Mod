# Code Signing

---

## Current Situation

The Electron overlay binaries are **unsigned**. This causes two visible problems for users:

1. **Windows SmartScreen** shows an "Unknown Publisher" warning (blue or red dialog depending on reputation). Users must click "More info" → "Run anyway".
2. **Antivirus false positives** — some engines flag the installer due to low reputation (no signing certificate + no download history). After the v1.3.0 rewrite removed game-memory reading and network scanning, there is no behavioral reason for detection; the remaining triggers are all reputation/signing-based.

The VirusTotal permalink for each release is served at `https://falloutchatmod.com/virustotal` and is updated by `Packaging/publish-nexus-release.ps1` on every publish.

---

## Durable Fix: Azure Trusted Signing

The planned solution is **Azure Trusted Signing** ($9.99/month), signed as the "Devotek" business entity so the publisher name appears as "Devotek" rather than a personal legal name.

Full setup guides:

- **`docs/CODE-SIGNING.md`** — overview, Alberta business license path (Canadian CRA Business Number instead of US EIN), `signtool` integration into the build script, behavioral mitigations (replacing `SetWindowsHookEx` with `RegisterHotKey`), and false-positive submission links.
- **`docs/AZURE-CODE-SIGNING-SETUP.md`** — step-by-step organization validation walkthrough: D-U-N-S number (the slow bottleneck — request first), business registration, Azure account + certificate profile creation, service principal + IAM role, `azureSignOptions` in `cross-platform-overlay/package.json`, and a GitHub Actions CI skeleton.

---

## Summary of Steps (order matters)

1. Request a free D-U-N-S number (up to 30 days — start immediately)
2. Register "Devotek" as a business entity (DBA or LLC), using the exact same name/address as the D-U-N-S
3. Create an Azure Trusted Signing account (Basic tier, $9.99/month, supported region)
4. Organization identity validation → Approved
5. Certificate profile (Public Trust) → CN = "Devotek"
6. App registration + "Certificate Profile Signer" IAM role → tenant/client/secret
7. Add `azureSignOptions` to `cross-platform-overlay/package.json`
8. CI workflow (Windows runner) with the three Azure secrets, or sign locally from Windows PowerShell

After signing: SmartScreen shows "Publisher: Devotek" (blue dialog, not red block). After sufficient download volume, the SmartScreen warning disappears entirely.

---

## Behavioral Mitigations (independent of signing)

Two behavioral items still influence heuristic AV engines regardless of signing status:

- **Replace `SetWindowsHookEx(WH_KEYBOARD_LL)` with `RegisterHotKey`** in the global hotkey handler. The low-level keyboard hook is a classic keylogger signature. `RegisterHotKey` (user32) registers system hotkeys without installing a hook. Status: recommended, not yet done — test overlay hotkeys thoroughly before shipping.
- **Keep builds framework-dependent** (not single-file/self-contained). Bundled/packed executables trip "packer" AV heuristics. The current `.csproj` files set `RuntimeIdentifier` but not `SelfContained`/`PublishSingleFile` — keep it this way.

---

## False-Positive Submissions

After each notable release, submit the installer and executables to:

- **Microsoft Defender:** https://www.microsoft.com/en-us/wdsi/filesubmission (as a developer, "incorrectly detected as malware")
- **AVG / Avast:** https://www.avg.com/en/false-positive-file-form (shared engine)
- **VirusTotal:** `Packaging/publish-nexus-release.ps1` uploads automatically and prints the permalink

For full priority ordering and notes, see `docs/CODE-SIGNING.md` → "Mitigation priority".
