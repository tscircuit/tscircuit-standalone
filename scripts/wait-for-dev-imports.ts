type FileEvent = { event_type: string; file_path?: string }

export async function waitForDevImports(
  origin: string,
  importedPaths: readonly string[],
  {
    hasExited,
    timeoutMs = 60_000,
    requestTimeoutMs = 5000,
    pollIntervalMs = 100,
  }: {
    hasExited: () => boolean
    timeoutMs?: number
    requestTimeoutMs?: number
    pollIntervalMs?: number
  },
) {
  const deadline = performance.now() + timeoutMs
  let lastTimeout: unknown
  const checkDev = () => {
    if (hasExited())
      throw new Error("tsci dev exited while synchronizing imports")
  }
  while (performance.now() < deadline) {
    checkDev()
    try {
      const response = await fetch(`${origin}/api/events/list`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(
          requestTimeoutMs,
          Math.ceil(deadline - performance.now()),
        ))),
      })
      if (!response.ok)
        throw new Error(`Dev import event request failed (HTTP ${response.status})`)
      const { event_list } = await response.json() as { event_list: FileEvent[] }
      const updatedPaths = new Set(event_list
        .filter((event) => event.event_type === "FILE_UPDATED")
        .map((event) => event.file_path?.replaceAll("\\", "/")))
      if (importedPaths.every((path) => updatedPaths.has(path))) return
    } catch (error) {
      // Dependency uploads can briefly delay this endpoint on a busy runner.
      // Retry request timeouts without hiding HTTP errors or malformed events.
      if (!(error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name))) throw error
      lastTimeout = error
    }
    checkDev()
    const remaining = deadline - performance.now()
    if (remaining > 0) await Bun.sleep(Math.min(pollIntervalMs, remaining))
  }
  throw new Error(`Dev did not synchronize the imported parts within ${timeoutMs}ms`, {
    cause: lastTimeout,
  })
}
