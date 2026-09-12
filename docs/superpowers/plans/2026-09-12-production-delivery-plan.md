# Daily Agent Digest Production Delivery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a verifiable one-click daily agent digest product whose installed app, not only its source tree, generates thematic reports, renders them correctly, updates as a single tray instance, and can be reproduced from a public release.

**Architecture:** The Python engine owns collection, token-efficient thematic summarization, persistent report state, scheduling decisions, and the app-command JSON protocol. Native tray clients are thin platform views over that protocol. The installer atomically replaces the engine and platform app, owns exactly one startup service, and writes a local install manifest containing the release version and asset hashes.

**Tech Stack:** Python 3.10+ standard library, AppKit/Swift on macOS, WinForms/C# on Windows, PyInstaller, GitHub Actions, Developer ID signing/notarization, launchd/Windows Startup.

---

## Definition Of Done

- A clean macOS machine can run the public one-line installer and receive the same release version recorded in `install-manifest.json`.
- Re-running the installer while the tray is active leaves exactly one tray process and one tray icon; the old process is stopped before replacement and the new process is started after replacement.
- The installer verifies the downloaded engine, app archive, and checksum manifest from one immutable release. A cache-busted download cannot mix release assets.
- The engine has a deterministic protocol contract for `settings`, `save-settings`, `clear`, `generate`, `state`, `exclude`, `restore`, `submit`, and `tick`; every command returns valid JSON or a structured error and never leaks the API key.
- Generation clears only the selected day’s old generated content, preserves explicit exclusions, emits progress states (`generating`, `ready`, `submitted`, `error`), and never reports success when the LLM request or persistence fails.
- The normal LLM path sends one locally deduplicated and bounded daily context, asks for thematic work items, and renders no session IDs as work titles. The fallback path groups by provider and is visibly marked as unclassified.
- The macOS UI displays a real summary, work titles, details, status, exclusion controls, errors, and item count. The success dialog has no progress bar; the generation dialog has a progress indicator only while work is running and exposes “查看今日总结” only after success.
- CI runs Python tests, Swift compilation, both architecture builds, signature verification, notarization, checksum generation, and a release asset audit. The public release contains engine binaries, both app archives, installer, and checksums.
- A clean-room smoke test downloads the public installer, installs into an isolated `DIGEST_HOME`, verifies permissions, confirms the manifest version, invokes the protocol, and checks that the app archive is installed.

## Current Findings To Close

1. The screenshot can be from an older installed app even when source and engine are newer. The installed app bundle, engine, launch agent, release tag, and UI build hash must be reported together.
2. The existing installer updates the engine and app through separate operations and has no manifest, making version skew hard to detect.
3. The Swift UI has previously had missing `contentView`, table sizing, modal accessory cleanup, and pipe-drain bugs. These require automated UI smoke checks and explicit source assertions.
4. Windows is not compiled on the macOS host and its settings/report behavior is not covered by CI.
5. The current release pipeline must audit exact public assets after publishing instead of trusting the job exit code.

### Task 1: Freeze the engine protocol and state model

**Files:**
- Modify: `daily_agent_digest.py`
- Create: `tests/test_core.py` (extend existing tests)

- [ ] Write tests for all commands using an isolated `DIGEST_HOME`: `clear` removes work items but preserves exclusions, `save-settings` writes mode `600`, `state` returns a stable schema, unknown commands return a structured error, and `submit` never includes excluded items.
- [ ] Define a single state schema with `schema_version`, `date`, `summary`, `work_items`, `generated_at`, `report_status`, `last_error`, `reports`, `coverage`, and `release_version`.
- [ ] Make writes atomic with a temporary file plus `os.replace`, and write debug records only when `DIGEST_DEBUG=1`.
- [ ] Move the collection root into an explicit `DIGEST_SOURCE_ROOT` environment variable used by both CLI and app commands; tests must never read the real home directory.
- [ ] Make `generate(day)` call the collector once, compact duplicate excerpts, cap the request by characters and event count, parse strict JSON, validate each returned work item, and retain the pre-generation exclusion IDs.
- [ ] Make error states persistent and return nonzero process status with `{"error": ...}` without exposing request headers or API keys.
- [ ] Run `python -m unittest discover -s tests -v` and assert all protocol tests pass.

### Task 2: Implement thematic token budgeting

**Files:**
- Modify: `daily_agent_digest.py`
- Modify: `README.md`
- Test: `tests/test_core.py`

- [ ] Define the budget constants in one place: maximum 900-character excerpt, maximum 90,000 UTF-8 characters per request, maximum 20 work items, and deterministic duplicate fingerprints.
- [ ] Include provider/session references as metadata while forbidding session IDs in titles.
- [ ] Validate the LLM response shape and reject malformed or empty work-item titles instead of silently replacing a successful report with session rows.
- [ ] Add tests for duplicate collapse, character budget, malformed JSON, provider fallback, and exclusion preservation.
- [ ] Document the exact token-saving behavior and its limitation in `README.md`.

### Task 3: Make the macOS UI production-verifiable

**Files:**
- Modify: `native/macos/DailyAgentDigest.swift`
- Modify: `native/macos/build.sh`
- Create: `native/macos/ui-smoke-test.sh`

- [ ] Split backend transport, report window, generation modal, and settings form into testable Swift types without changing the JSON protocol.
- [ ] Drain stdout before waiting for the child process, capture stderr, enforce a timeout, and surface structured errors in the UI.
- [ ] Make the report window explicitly assign `contentView`, size the table document view, render summary and details, and show a visible empty/error state.
- [ ] Make generation sequence `clear -> progress -> generate -> success/error`; remove the accessory progress view before showing success actions; only enable “查看今日总结” after validated state is returned.
- [ ] Add a visible build version and engine path to a diagnostics panel so a screenshot can prove which build is running.
- [ ] Ensure close hides the report window, Quit terminates the single app, and the timer cannot create another process.
- [ ] Build the app with `swiftc` and run a UI smoke test that instantiates the window/modal path with a fixture backend and checks content view, row count, summary text, and post-success accessory absence.

### Task 4: Make installation and upgrade atomic

**Files:**
- Modify: `install.sh`
- Modify: `README.md`
- Create: `scripts/test-install.sh`

- [ ] Download all assets with one release version or resolve and pin the tag before downloading; cache-bust every asset URL.
- [ ] Verify checksums before changing any installed file and verify the engine signature and app bundle signature/notarization.
- [ ] Stop old launch agents and exact old process IDs before replacing files; never use a broad `pkill` pattern that can match unrelated processes.
- [ ] Extract the app into a temporary directory, validate its executable and bundle identifier, then atomically move it into place.
- [ ] Write `install-manifest.json` containing release tag, engine SHA256, app SHA256, install time, architecture, and executable paths.
- [ ] Register exactly one tray launch agent with `RunAtLoad`; remove obsolete launch agents and never call both `launchctl` and `open` for startup.
- [ ] Add an isolated installer test with mocked curl/codesign/launchctl that verifies API key preservation, mode `600`, checksum failure leaves the previous install intact, and repeated install creates one manifest and one launch definition.

### Task 5: Finish Windows parity and build verification

**Files:**
- Modify: `native/windows/DailyAgentDigestTray.cs`
- Modify: `native/windows/build.ps1`
- Modify: `.github/workflows/build-release.yml`

- [ ] Implement the same report window fields and generation state as macOS, including details, exclusion, restore, progress, success, and error states.
- [ ] Make settings load current values and submit escaped JSON values; do not display or log the API key.
- [ ] Use a named mutex and a single Startup registration; upgrade must stop the existing tray process before replacing files.
- [ ] Add a Windows CI job that compiles with the intended .NET Framework references and runs `--ui-smoke-test`.

### Task 6: Release and clean-room acceptance

**Files:**
- Modify: `.github/workflows/build-release.yml`
- Modify: `scripts/ci-build.sh`
- Create: `scripts/release-audit.sh`

- [ ] Build engine and native UI for every supported architecture, sign the complete app bundle, notarize it, and archive the notarized bundle.
- [ ] Generate SHA256 sums only after final assets exist; publish only explicit files, never directories or broad globs.
- [ ] After `gh release create`, download the public release asset list and assert required names, checksums, architecture, signature, and install script availability.
- [ ] Run the clean-room installer test against the public `latest` URL and assert the installed manifest tag equals the release tag.
- [ ] Publish only after all required checks pass; update README with the exact release URL and recovery instructions.

## Required Evidence Before Delivery

- `python -m unittest discover -s tests -v` output with all tests passing.
- Swift compile and UI smoke output.
- Windows compile/UI smoke output from GitHub Actions.
- A public release asset list containing both app archives, both engine binaries, `install.sh`, and `SHA256SUMS`.
- A clean-room installation transcript showing one tray launch agent, one tray process, preserved `.env` mode `600`, and matching install manifest hashes.
- A manual screenshot or recorded UI assertion showing summary text, thematic titles, details, progress-only-during-generation, and no progress bar after success.

## Stop Conditions

Do not call the project delivered if any of these are true: the running app version cannot be tied to a release tag; release assets are not audited; UI smoke is untested; an installer rerun can create two startup entries/processes; or a generation failure can leave the UI claiming success.
