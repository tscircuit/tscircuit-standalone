import { afterEach, expect, test } from "bun:test"
import { waitForDevImports } from "../scripts/wait-for-dev-imports"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

const importedPaths = ["imports/AM62L32.tsx", "imports/AM3358BZCZA100.tsx"]
const updatedEvents = () => importedPaths.map((file_path) => ({
  event_type: "FILE_UPDATED",
  file_path,
}))

test("a request timeout during uploads is retried until both imports synchronize", async () => {
  let requests = 0
  const origin = serve(async () => {
    requests++
    if (requests === 1) await Bun.sleep(300)
    return Response.json({ event_list: updatedEvents() })
  })
  await waitForDevImports(origin, importedPaths, {
    hasExited: () => false,
    timeoutMs: 2000,
    requestTimeoutMs: 50,
    pollIntervalMs: 5,
  })
  expect(requests).toBeGreaterThanOrEqual(2)
})

test("waits for every FILE_UPDATED event and normalizes Windows paths", async () => {
  let requests = 0
  const origin = serve(() => Response.json({
    event_list: ++requests === 1
      ? [{ event_type: "FILE_UPDATED", file_path: importedPaths[0] },
         { event_type: "FILE_CREATED", file_path: importedPaths[1] }]
      : updatedEvents().map((event) => ({
          ...event, file_path: event.file_path.replaceAll("/", "\\"),
        })),
  }))
  await waitForDevImports(origin, importedPaths, {
    hasExited: () => false,
    pollIntervalMs: 5,
  })
  expect(requests).toBe(2)
})

test("persistent request timeouts respect the overall deadline", async () => {
  const origin = serve(async () => {
    await Bun.sleep(500)
    return Response.json({ event_list: [] })
  })
  await expect(waitForDevImports(origin, importedPaths, {
    hasExited: () => false,
    timeoutMs: 100,
    requestTimeoutMs: 5000,
  })).rejects.toThrow("within 100ms")
}, 2000)

test("missing import events still fail after the deadline", async () => {
  const origin = serve(() => Response.json({ event_list: [] }))
  await expect(waitForDevImports(origin, importedPaths, {
    hasExited: () => false,
    timeoutMs: 50,
    pollIntervalMs: 5,
  })).rejects.toThrow("Dev did not synchronize the imported parts")
})

test("a terminated dev process fails immediately", async () => {
  let requests = 0
  const origin = serve(() => {
    requests++
    return Response.json({ event_list: updatedEvents() })
  })
  await expect(waitForDevImports(origin, importedPaths, {
    hasExited: () => true,
  })).rejects.toThrow("tsci dev exited while synchronizing imports")
  expect(requests).toBe(0)
})

test("HTTP failures are not retried", async () => {
  let requests = 0
  const origin = serve(() => {
    requests++
    return new Response("Server error", { status: 500 })
  })
  await expect(waitForDevImports(origin, importedPaths, {
    hasExited: () => false,
  })).rejects.toThrow("HTTP 500")
  expect(requests).toBe(1)
})

test("malformed event responses are not hidden by retries", async () => {
  const origin = serve(() => new Response("invalid JSON"))
  await expect(waitForDevImports(origin, importedPaths, {
    hasExited: () => false,
  })).rejects.toThrow(SyntaxError)
})
