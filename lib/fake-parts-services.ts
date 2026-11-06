import { readFile, realpath, stat } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { createFakeSearchHandler } from "./fake-search-handler"

/** Standalone owns these API replacements. Clients only receive normal base URLs. */
export async function startFakePartsServices(directory: string) {
  const root = await realpath(directory)
  if (!(await stat(root)).isDirectory())
    throw new Error("Expected a standalone asset directory")
  const search = createFakeSearchHandler(root)
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Expose-Headers", "X-Tscircuit-Catalog")
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD, POST",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      })
      response.end()
      return
    }
    const url = new URL(request.url!, "http://localhost")
    const registrySearch = url.pathname === "/tscircuit/packages/search"
    const jsonPost =
      request.headers["content-type"]?.startsWith("application/json")
    const formPost = request.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded",
    )
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !(request.method === "POST" && (formPost || (jsonPost && registrySearch)))
    ) {
      response.writeHead(405)
      response.end("Method not allowed")
      return
    }
    try {
      let query: string | undefined
      if (request.method === "POST") {
        let body = ""
        for await (const chunk of request) {
          body += chunk.toString()
          if (Buffer.byteLength(body) > 64 * 1024) {
            response.writeHead(413)
            response.end("Request too large")
            return
          }
        }
        if (jsonPost) {
          try {
            const parsed = JSON.parse(body)
            if (typeof parsed.query !== "string")
              throw new Error("Expected query")
            query = parsed.query
          } catch {
            response.writeHead(400)
            response.end("Expected a JSON query string")
            return
          }
        } else {
          for (const [key, value] of new URLSearchParams(body))
            url.searchParams.append(key, value)
        }
      }
      const result = await search(url, query)
      if (result) {
        result.headers.forEach((value, key) => response.setHeader(key, value))
        response.writeHead(result.status)
        response.end(
          request.method === "HEAD"
            ? undefined
            : Buffer.from(await result.arrayBuffer()),
        )
        return
      }
      // Existing datasheet/model snapshots are served by the standalone process too.
      let relative = decodeURIComponent(url.pathname)
      if (url.search) {
        url.searchParams.sort()
        relative = path.join(
          relative,
          `${encodeURIComponent(url.searchParams.toString()).replace(/\*/g, "%2A")}.json`,
        )
      }
      const file = await realpath(path.join(root, relative))
      const contained = path.relative(root, file)
      if (
        contained === ".." ||
        contained.startsWith(`..${path.sep}`) ||
        path.isAbsolute(contained)
      ) {
        response.writeHead(404)
        response.end("Not found")
        return
      }
      const bytes = await readFile(file)
      response.writeHead(200, {
        "Content-Type":
          file.endsWith(".json") || url.pathname.startsWith("/datasheet-api/")
            ? "application/json"
            : "application/octet-stream",
      })
      response.end(request.method === "HEAD" ? undefined : bytes)
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
      response.writeHead(missing ? 404 : 500)
      response.end(missing ? "Not found" : "Invalid standalone service data")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Missing fake service port")
  const origin = `http://127.0.0.1:${address.port}`
  return {
    server,
    env: {
      TSCIRCUIT_JLCSEARCH_BASE_URL: `${origin}/jlcsearch`,
      TSCIRCUIT_DIGIKEY_BASE_URL: `${origin}/digikey`,
      TSCIRCUIT_MOUSER_BASE_URL: `${origin}/mouser`,
      TSCIRCUIT_TI_BASE_URL: `${origin}/ti`,
      TSCIRCUIT_KICAD_BASE_URL: `${origin}/kicad`,
      TSCIRCUIT_REGISTRY_API_URL: `${origin}/tscircuit`,
      TSCIRCUIT_DATASHEET_API_BASE_URL: `${origin}/datasheet-api`,
      TSCIRCUIT_BAKED_ASSET_SERVER_BASE_URL: origin,
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
