# brave-perf

A tool that connects to your **Brave** browser, measures real performance for **YouTube and general page browsing**, and helps you maximize it — on Windows.

It has two parts:

| Part | What it does | Risk |
|------|--------------|------|
| **CLI** (`cli/`) | Launches a debug Brave, measures pages + YouTube over the DevTools Protocol, reads your config, and **auto-applies** browser-wide fixes through supported, reversible channels. | `audit`/`benchmark` are read-only. `apply` only writes with `--yes`. |
| **Extension** (`extension/`) | In-browser: live Web Vitals + system stats, and a **Force H.264** toggle for YouTube to engage hardware video decoding. | Reversible; remove the extension to undo. |

No npm install needed — the CLI is zero-dependency (uses Node 22+'s built-in `fetch` and global `WebSocket`).

## Requirements

- Windows, Brave installed (auto-detected; this machine: `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`)
- Node.js **≥ 22** (verified on 24.13)

## CLI usage

```powershell
node cli/index.js doctor      # check Brave path / version / Node readiness
node cli/index.js audit       # READ-ONLY review of your Brave config + recommendations
node cli/index.js benchmark   # launch debug Brave, measure pages + YouTube codec/drops
node cli/index.js apply       # DRY-RUN preview of browser-wide fixes
node cli/index.js apply --yes # actually apply them
node cli/index.js revert --yes# undo everything apply changed
```

Useful flags: `--headless`, `--pages=a,b,c`, `--youtube=URL` (or `--youtube=false`),
`--optimized` (benchmark *with* GPU flags for A/B), `--only=id1,id2`, `--exe=PATH`.

### What `benchmark` measures

- **Pages:** LCP, CLS, INP, TTFB, load time, CPU during settle, long tasks, JS heap, transfer size — via CDP `Performance.getMetrics` (diffed snapshots) + `PerformanceObserver`.
- **YouTube:** resolution, dropped frames, active codec (AV1 / VP9 / H.264), and a per-codec **hardware-vs-software decode** probe (`mediaCapabilities.decodingInfo().powerEfficient`), plus CPU during playback.

> It runs in a **throwaway profile** (`%TEMP%\brave-perf-bench-profile`), never your real one, so measurements are clean and your data is untouched. You can't attach to an already-running Brave — Chromium only opens the debug port when launched with the flag.

### How `apply` is safe

It never edits Brave's `Preferences`/`Local State` JSON (Brave rewrites + HMAC-guards those). Instead it uses:

1. **Enterprise-policy registry** under `HKCU\Software\Policies\BraveSoftware\Brave` (no admin needed, survives updates): `HardwareAccelerationModeEnabled`, `NetworkPredictionOptions`.
2. An **optimized launcher** (`Start Brave (optimized).cmd` + a Desktop shortcut) that starts Brave with `--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy`.

Every change is recorded to `apply-state.json`, and `revert --yes` undoes exactly what was applied. **Relaunch Brave** for changes to take effect.

## Extension: load it

1. Open `brave://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select the `extension/` folder
4. Pin it, open a YouTube video, click the toolbar icon

The **Force H.264** toggle helps most on machines whose GPU lacks AV1/VP9 hardware decode (older laptops). Trade-off: caps some videos at 1080p and uses more bandwidth, so it's off by default. On a GPU that *does* decode AV1/VP9 in hardware, leave it off — `benchmark` will tell you which case you're in.

## How it works (the short version)

- **Connect:** Brave is Chromium-based, so the CLI speaks the Chrome DevTools Protocol over a WebSocket to a debug instance it launches.
- **Measure:** CDP for renderer CPU/FPS/heap (things pages can't see) + in-page Web APIs for vitals and YouTube playback stats.
- **Tune:** browser-wide via policy registry / launch flags; YouTube codec via the extension's MAIN-world `MediaSource.isTypeSupported` patch (the "h264ify" technique).

## Layout

```
cli/
  index.js            # command dispatch (doctor/audit/benchmark/apply/revert)
  lib/
    paths.js          # locate brave.exe + profile dirs
    cdp.js            # zero-dep DevTools Protocol client
    launch.js         # launch debug Brave (throwaway profile)
    config-read.js    # READ-ONLY Brave settings snapshot
    page-metrics.js   # injected vitals + YouTube probe scripts
    benchmark.js      # orchestrate measurement
    recommend.js      # config + results -> prioritized fixes
    apply.js          # policy-registry + launcher apply/revert
    report.js         # console formatting
extension/
  manifest.json
  yt-codec.js         # MAIN world: codec forcing + stats reader
  yt-bridge.js        # isolated world: chrome.storage <-> page bridge
  vitals.js           # isolated world: Web Vitals collector
  popup.html/.css/.js # toolbar UI
```
