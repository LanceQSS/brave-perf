// Turn a config snapshot + benchmark results into a prioritized, actionable list.
// Each recommendation is data only; rendering lives in report.js.

// Stable ids let apply.js know which auto-fixes the user can opt into.
export const FIX = {
  HW_ACCEL: 'hardware-acceleration',
  PRELOAD: 'preloading',
  GPU_BLOCKLIST: 'ignore-gpu-blocklist',
  FORCE_H264: 'force-h264',
  MEMORY_SAVER: 'memory-saver',
};

export function buildRecommendations({ config, benchmark } = {}) {
  const recs = [];

  // --- Browser-wide config levers (from on-disk state) ---
  if (config) {
    if (config.hardwareAcceleration === false) {
      recs.push({
        id: FIX.HW_ACCEL,
        severity: 'high',
        title: 'Enable hardware (GPU) acceleration',
        why: 'GPU acceleration is OFF, so compositing and video decode run on the CPU — the single biggest drag on smooth scrolling and video.',
        how: 'brave://settings/system → "Use graphics acceleration when available" → on, then relaunch.',
        auto: 'apply sets the HardwareAccelerationModeEnabled policy (HKCU).',
        autoApplicable: true,
      });
    } else if (config.hardwareAcceleration === undefined) {
      recs.push({
        id: FIX.HW_ACCEL,
        severity: 'info',
        title: 'Could not read hardware-acceleration state',
        why: 'Local State was unreadable (Brave may be running / first launch). Check brave://gpu manually.',
        how: 'Open brave://gpu and confirm "Video Decode: Hardware accelerated".',
        autoApplicable: false,
      });
    }

    if (config.networkPrediction === 2) {
      recs.push({
        id: FIX.PRELOAD,
        severity: 'medium',
        title: 'Re-enable page preloading',
        why: 'Preloading is disabled, so pages start fetching only after you click — adds latency to navigation.',
        how: 'brave://settings/privacy → "Preload pages for faster browsing".',
        auto: 'apply sets NetworkPredictionOptions=0 policy (HKCU).',
        autoApplicable: true,
      });
    }

    const hasGpuRaster = (config.enabledLabsExperiments || []).some((f) => f.startsWith('enable-gpu-rasterization'));
    if (!hasGpuRaster) {
      recs.push({
        id: FIX.GPU_BLOCKLIST,
        severity: 'low',
        title: 'Force GPU rasterization / ignore GPU blocklist',
        why: 'On some GPUs Brave conservatively disables acceleration. Forcing it can smooth heavy pages — verify it stays stable.',
        how: 'brave://flags → enable "GPU rasterization"; or use the optimized launch shortcut.',
        auto: 'apply generates a "Start Brave (optimized)" launcher with --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy.',
        autoApplicable: true,
      });
    }

    if (config.batterySaverState === 0 && config.highEfficiencyState === 0) {
      recs.push({
        id: FIX.MEMORY_SAVER,
        severity: 'low',
        title: 'Consider Memory Saver for many-tab sessions',
        why: 'Memory Saver discards idle tabs to free RAM, which helps when dozens of tabs are open.',
        how: 'brave://settings/performance → Memory Saver → on.',
        autoApplicable: false,
      });
    }
  }

  // --- YouTube codec/decode (from benchmark) ---
  const yt = benchmark?.youtube?.youtube;
  if (yt && yt.decode) {
    // A codec the GPU can't decode at all reports {supported:false, powerEfficient:false};
    // guard on `supported` so "unsupported" isn't mistaken for "software-decoded" (the
    // popup's classifyDecode does the same — keep the two verdicts in sync).
    const av1Sw = yt.decode.AV1 && yt.decode.AV1.supported && yt.decode.AV1.powerEfficient === false;
    const vp9Sw = yt.decode.VP9 && yt.decode.VP9.supported && yt.decode.VP9.powerEfficient === false;
    const h264Hw = yt.decode['H.264'] && yt.decode['H.264'].powerEfficient === true;
    const playingHeavyCodec = yt.codec === 'AV1' || yt.codec === 'VP9';
    const highDrops = yt.video && yt.video.dropPct > 1;

    if ((av1Sw || vp9Sw) && h264Hw && (playingHeavyCodec || highDrops)) {
      recs.push({
        id: FIX.FORCE_H264,
        severity: 'high',
        title: 'Force H.264 on YouTube (engage hardware decode)',
        why: `YouTube is using ${yt.codec || 'AV1/VP9'} which decodes in SOFTWARE on this GPU (high CPU/battery${
          highDrops ? `, ${yt.video.dropPct}% dropped frames` : ''
        }). H.264 has hardware decode here.`,
        how: 'Install the included Brave extension and toggle "Force H.264" (it reloads YouTube for you).',
        auto: 'enabled via the extension popup (reversible; caps some videos at 1080p).',
        autoApplicable: false, // applied in the browser, not via registry
      });
    } else if (yt.codec && h264Hw) {
      recs.push({
        id: FIX.FORCE_H264,
        severity: 'info',
        title: `YouTube codec: ${yt.codec}` + (yt.video ? ` · ${yt.video.dropPct}% dropped` : ''),
        why:
          playingHeavyCodec && !av1Sw && !vp9Sw
            ? `${yt.codec} is hardware-accelerated on this GPU — no need to force H.264.`
            : 'Playback looks healthy.',
        how: 'No action needed.',
        autoApplicable: false,
      });
    }
  }

  // Stable severity ordering.
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  recs.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return recs;
}
