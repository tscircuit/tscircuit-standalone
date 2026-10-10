import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { installEvalWorkerPolicy } from "../ui/eval-worker-policy"

const globalNames = [
  "fetch",
  "location",
  "postMessage",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
] as const
const originalGlobals = new Map(
  globalNames.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
)
const nativeFetch = mock(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("bundled asset"),
)
const nativeOpen = mock(
  (
    _method: string,
    _url: string | URL,
    _async = true,
    _username?: string | null,
    _password?: string | null,
  ) => {},
)
const nativeWebSocket = mock(() => {})
const nativeEventSource = mock(() => {})
const postMessage = mock((_message: unknown) => {})

beforeEach(() => {
  nativeFetch.mockClear()
  nativeOpen.mockClear()
  nativeWebSocket.mockClear()
  nativeEventSource.mockClear()
  postMessage.mockClear()
  const values = {
    fetch: nativeFetch,
    location: {
      href: "http://localhost:3050/assets/eval-worker.js",
      origin: "http://localhost:3050",
    },
    postMessage,
    XMLHttpRequest: class {
      open(
        method: string,
        url: string | URL,
        async = true,
        username?: string | null,
        password?: string | null,
      ) {
        nativeOpen(method, url, async, username, password)
      }
    },
    WebSocket: class {
      constructor() {
        nativeWebSocket()
      }
    },
    EventSource: class {
      constructor() {
        nativeEventSource()
      }
    },
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
})

afterEach(() => {
  for (const name of globalNames) {
    const descriptor = originalGlobals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

test("bundled worker assets use the native transport without following redirects", async () => {
  const policy = installEvalWorkerPolicy()
  await fetch("/assets/router.wasm", { redirect: "follow" })
  await fetch(
    new Request("http://localhost:3050/assets/font.woff", { method: "HEAD" }),
  )
  await fetch("data:application/json,%7B%7D")
  expect(nativeFetch).toHaveBeenCalledTimes(3)
  expect(nativeFetch.mock.calls[0]).toEqual([
    "/assets/router.wasm",
    { redirect: "error" },
  ])
  expect(nativeFetch.mock.calls[1]?.[1]).toEqual({ redirect: "error" })
  expect(policy.rejectedRequests).toHaveLength(0)
  expect(() => policy.assertNoRejectedRequests()).not.toThrow()
  expect(postMessage).not.toHaveBeenCalled()
})

test("remote and unsupported requests are recorded before the native transport runs", async () => {
  const policy = installEvalWorkerPolicy()
  for (const [url, init] of [
    ["https://example.invalid/assets/file.json", undefined],
    ["//example.invalid/assets/file.json", undefined],
    ["/api/circuit", undefined],
    ["/assets/../api/circuit", undefined],
    ["http://user:pass@localhost:3050/assets/file.json", undefined],
    ["/assets/file.json", { method: "POST" }],
  ] satisfies Array<[string, RequestInit | undefined]>) {
    await expect(fetch(url, init)).rejects.toThrow(
      "No network request was attempted",
    )
  }
  await expect(
    fetch(
      new Request("http://localhost:3050/assets/file.json", { method: "PUT" }),
    ),
  ).rejects.toThrow("PUT")
  expect(nativeFetch).not.toHaveBeenCalled()
  expect(policy.rejectedRequests).toHaveLength(7)
  expect(postMessage).toHaveBeenCalledTimes(7)
  expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
    type: "standalone:request-rejected",
  })
  expect(() => policy.assertNoRejectedRequests()).toThrow("example.invalid")
  policy.clear()
  expect(() => policy.assertNoRejectedRequests()).not.toThrow()
  await fetch("/assets/file.json")
  expect(nativeFetch).toHaveBeenCalledTimes(1)
})

test("XHR applies the same resource policy and preserves the synchronous overload", () => {
  installEvalWorkerPolicy()
  const xhr = new XMLHttpRequest()
  xhr.open("HEAD", "/assets/file.json", false)
  expect(nativeOpen).toHaveBeenCalledWith(
    "HEAD",
    "/assets/file.json",
    false,
    undefined,
    undefined,
  )
  expect(() => xhr.open("GET", "https://example.invalid/file.json")).toThrow(
    "No network request was attempted",
  )
  expect(() => xhr.open("POST", "/assets/file.json")).toThrow(
    "No network request was attempted",
  )
  expect(nativeOpen).toHaveBeenCalledTimes(1)
})

test("streaming transports and preconnect are rejected before construction", () => {
  const policy = installEvalWorkerPolicy()
  expect(() => new WebSocket("ws://localhost:3050/assets/socket")).toThrow(
    "WebSocket",
  )
  expect(() => new EventSource("/assets/events")).toThrow("EventSource")
  expect(() => fetch.preconnect("https://example.invalid")).toThrow(
    "Preconnect",
  )
  expect(nativeWebSocket).not.toHaveBeenCalled()
  expect(nativeEventSource).not.toHaveBeenCalled()
  expect(nativeFetch).not.toHaveBeenCalled()
  expect(policy.rejectedRequests).toHaveLength(3)
})
