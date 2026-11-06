const upstreamFetch = globalThis.fetch
// Prove API clients use the advertised loopback services, with public HTTP denied.
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error(`External HTTP attempted: ${url}`)
    return upstreamFetch(input, init)
  },
  upstreamFetch,
)
