# Releases and signing

## Download a release

Use the repository's [Releases page](https://github.com/angomedia/ai-collab/releases/latest). Each release contains:

- `AI-Collab-<version>-mac-arm64.dmg` and `.zip` for Apple Silicon.
- `AI-Collab-<version>-mac-x64.dmg` and `.zip` for Intel Macs.
- `AI-Collab-<version>-win-x64.exe` for Windows Intel/AMD PCs.
- `SHA256SUMS.txt` for verifying the downloads.

The app and Electron runtime are bundled. Codex and Claude Code are installed separately through **Connections** and authenticate with each user's own accounts. Personal history, settings, source documents, and credentials are not part of release builds.

To verify a download on Mac:

```sh
shasum -a 256 AI-Collab-1.6.0-mac-arm64.dmg
```

On Windows PowerShell:

```powershell
Get-FileHash .\AI-Collab-1.6.0-win-x64.exe -Algorithm SHA256
```

Compare the result with the corresponding line in the release's `SHA256SUMS.txt`. A matching checksum detects a corrupted or changed download; it does not substitute for a trusted publisher signature.

## Build locally

Install dependencies with `npm ci`, then build on the same OS and CPU architecture as the installer:

```sh
npm run dist -- --mac --arm64
npm run dist -- --mac --x64
npm run dist -- --win --x64
```

Run only the command matching the machine. Cross-building is deliberately rejected because native PDF dependencies must match the packaged Electron runtime. macOS builds need the Xcode command-line tools for the native Swift document reader. Output is under `dist/release/`.

`npm run package` builds an unpacked application under `dist/`, useful for local testing. `npm run test:release` checks the electron-builder app from `dist/release/` without signing into providers. It uses a separate temporary profile and checks startup, defaults, and real document imports.

## Publish from GitHub Actions

The **Desktop checks** workflow runs unit and GUI tests on macOS and Windows for pushes to `main` and pull requests. Tests use fake CLIs; account credentials are not required.

The **Release installers** workflow runs on version tags and can also be started manually. It builds natively on three runners:

| Runner | Installer |
| --- | --- |
| `macos-15` | macOS arm64 |
| `macos-15-intel` | macOS x64 |
| `windows-2025` | Windows x64 |

Every release job runs unit tests, the GUI test, and a packaged-app smoke test. After all three jobs pass, a tag-triggered workflow checks the complete artifact set and checksums, then creates a **draft release**. Manual workflow runs upload build artifacts without creating a release.

To publish a new version:

1. Update the version in `package.json` and `package-lock.json`, and commit the completed change.
2. Push `main`, then create and push a matching version tag, for example `v1.6.1`. The workflow rejects a tag that differs from the package version.
3. Wait for all three release builds and tests to pass.
4. Review the draft's five downloads, checksums, and release notes. Include signing status, platform limitations, and any migration notes.
5. Publish the draft from GitHub Releases.

A rerun may replace assets in a draft. It refuses to overwrite an already published release. Fixes after publication should use a new patch version and tag.

## Optional publisher signing

Initial builds have no publisher certificate: Windows installers are unsigned; Mac builds have a local ad-hoc signature, which is **not** Apple Developer ID signing or notarization. These downloads can trigger OS warnings. Do not describe them as verified publisher releases.

To sign future builds, the repository owner must obtain their own certificates and store the following as **GitHub Actions secrets**, never as repository files:

| Platform | Secrets |
| --- | --- |
| Mac Developer ID signing | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| Mac notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows certificate signing | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

The `*_CSC_LINK` value can contain a base64-encoded supported certificate archive. Its password belongs in the matching password secret. Follow [electron-builder's signing documentation](https://www.electron.build/code-signing) for certificate formats and provider requirements. Hardware-backed or cloud signing services may require a custom signing integration beyond these certificate settings.

The build deliberately disables automatic discovery of certificates from a local keychain. Mac notarization is enabled only when both a signing identity and notarization credentials are configured. Configuring a certificate is not proof that signing succeeded: inspect the workflow output and verify the resulting artifacts before describing a release as signed or notarized.

No auto-update service is configured. Users close the app and install the new version over the old one; app data remains in their existing user-data folder. Windows uninstall leaves that data in place.
