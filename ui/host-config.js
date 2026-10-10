// Run before the app imports RunFrame, including its telemetry initialization.
window.TSCIRCUIT_TELEMETRY_DISABLED = true
window.TSCIRCUIT_ALLOW_SELECTING_EVAL_VERSION = false

// Initialize the PCB viewer's existing preference for browsers without WebGPU.
// Keep any rendering preference the user has already selected.
try {
  if (localStorage.getItem("pcb_viewer_rendering_engine") === null) {
    localStorage.setItem("pcb_viewer_rendering_engine", JSON.stringify("canvas"))
  }
} catch {
  // Storage may be unavailable; host settings above still apply.
}
