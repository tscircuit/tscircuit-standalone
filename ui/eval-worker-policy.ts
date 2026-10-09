export interface EvalWorkerPolicy {
  readonly rejectedRequests: readonly string[]
  reject(message: string): never
  clear(): void
  assertNoRejectedRequests(): void
}

/** Install before evaluator imports so native transports cannot bypass it. */
export function installEvalWorkerPolicy(): EvalWorkerPolicy {
  const rejectedRequests: string[] = []
  const record = (message: string) => {
    rejectedRequests.push(message)
    globalThis.postMessage({ type: "standalone:request-rejected", message })
  }
  const reject = (message: string): never => {
    record(message)
    throw new Error(message)
  }
  const allowedResource = (input: string | URL) => {
    const url = new URL(String(input), globalThis.location.href)
    return (
      url.protocol === "data:" ||
      (url.origin === globalThis.location.origin &&
        url.pathname.startsWith("/assets/") &&
        !url.username &&
        !url.password)
    )
  }
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const url = request?.url ?? String(input)
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
      if ((method !== "GET" && method !== "HEAD") || !allowedResource(url)) {
        return reject(
          `Request is not bundled in tscircuit standalone: ${method} ${url}. No network request was attempted.`,
        )
      }
      // Even a local URL must not follow a redirect to an external service.
      return nativeFetch(input, { ...init, redirect: "error" })
    },
    {
      preconnect: (url: string | URL): never =>
        reject(`Preconnect is not available in tscircuit standalone: ${url}.`),
    },
  ) as typeof fetch

  if (typeof XMLHttpRequest !== "undefined") {
    const nativeOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ) {
      if (!/^(GET|HEAD)$/i.test(method) || !allowedResource(url)) {
        reject(
          `Request is not bundled in tscircuit standalone: ${method} ${url}. No network request was attempted.`,
        )
      }
      return nativeOpen.call(this, method, url, async, username, password)
    }
  }
  if (typeof WebSocket !== "undefined") {
    globalThis.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        reject(
          `WebSocket requests are not available in tscircuit standalone: ${url}.`,
        )
        super(url, protocols)
      }
    }
  }
  if (typeof EventSource !== "undefined") {
    globalThis.EventSource = class extends EventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        reject(
          `EventSource requests are not available in tscircuit standalone: ${url}.`,
        )
        super(url, options)
      }
    }
  }
  return {
    rejectedRequests,
    reject,
    clear: () => {
      rejectedRequests.length = 0
    },
    assertNoRejectedRequests: () => {
      if (rejectedRequests.length > 0) throw new Error(rejectedRequests[0])
    },
  }
}
