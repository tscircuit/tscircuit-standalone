import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import packageMetadata from "../package.json"

const binary = resolve(
  process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci",
)
const projectDir = await mkdtemp(join(tmpdir(), "tscircuit-standalone-"))
const env = {
  PATH: projectDir,
  HOME: projectDir,
  TSCIRCUIT_CONFIG_DIR: join(projectDir, "config"),
  BUN_INSTALL_AUTO: "disable",
}
const run = (args: string[]) => {
  const result = Bun.spawnSync([binary, ...args], {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  })
  assert.equal(
    result.exitCode,
    0,
    `${args.join(" ")}: ${result.signalCode ?? ""}\n${result.stderr
      .toString()
      .split("\n")
      .map((line) => line.slice(0, 300))
      .join("\n")}`,
  )
  return result.stdout.toString()
}
let dev: Bun.Subprocess<"ignore", "inherit", "inherit"> | undefined
let staticServer: ReturnType<typeof Bun.serve> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  assert.equal(run(["--version"]).trim(), packageMetadata.version)
  assert.match(run(["--help"]), /CLI for developing tscircuit packages/)
  assert.match(run(["search", "RP2040"]), /RP2040/)
  const search = (args: string[]) =>
    JSON.parse(run(["search", "--json", ...args])) as {
      query: string
      results: Array<{
        source: string
        datasheet_id: string
        chip_name: string
      }>
    }
  const partialSearch = search(["rP204"])
  assert.equal(partialSearch.query, "rP204")
  assert.ok(partialSearch.results.length > 0)
  assert.ok(partialSearch.results.every((part) => part.source === "datasheets"))
  const rp2040 = partialSearch.results.find((part) => part.chip_name === "RP2040")
  assert.ok(rp2040, "Partial search must find the baked RP2040 datasheet")
  const explicitSearch = search(["--datasheets", "RP2040"])
  assert.ok(
    explicitSearch.results.some(
      (part) => part.datasheet_id === rp2040.datasheet_id && part.source === "datasheets",
    ),
  )
  assert.deepEqual(search(["not-a-baked-part-9e3cc416"]).results, [])
  run(["init", "initialized", "--yes", "--no-install"])
  for (const skillPath of [".claude/skills/tscircuit", ".agents/skills/tscircuit"]) {
    assert.ok(!existsSync(join(projectDir, "initialized", skillPath)))
  }
  assert.ok(await Bun.file(join(projectDir, "initialized/index.circuit.tsx")).exists())
  assert.ok(!existsSync(join(projectDir, "initialized/node_modules")))
  await writeFile(join(projectDir, "package.json"), "{}")
  run(["import", rp2040.chip_name])
  const { datasheet: importedDatasheet } = await Bun.file(
    `build/baked-asset-server/datasheet-api/datasheets/get/datasheet_id%3D${rp2040.datasheet_id}.json`,
  ).json()
  assert.equal(
    await readFile(join(projectDir, "imports", `${rp2040.chip_name}.tsx`), "utf8"),
    importedDatasheet.generated_tsx,
  )
  // A locally generated 2 x 3 x 2 mm solid exercises the viewer's STEP loader,
  // rather than allowing procedural footprint CAD to hide an OCCT failure.
  const stepFixture = await readFile(
    resolve(import.meta.dir, "../tests/fixtures/occt-box.step"),
    "utf8",
  )
  const stepUrl = `data:application/step;base64,${Buffer.from(stepFixture).toString("base64")}`
  await writeFile(
    join(projectDir, "index.tsx"),
    `export default () => <board width="10mm" height="10mm" partsEngineDisabled><chip name="U1" footprint="pinrow2" cadModel={{ stepUrl: ${JSON.stringify(stepUrl)} }} /></board>`,
  )
  // Exercise the shared CLI's sequential and embedded worker paths.
  for (const concurrency of ["1", "2"])
    run(["build", "index.tsx", "--ignore-errors", "--concurrency", concurrency])
  // `init` normally installs packages. The compiled CLI must still use its
  // registered engine and React, rather than import those packages by file URL.
  for (const name of ["tscircuit", "react"]) {
    const directory = join(projectDir, "node_modules", name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, type: "module", exports: { import: "./index.js" } }),
    )
    await writeFile(
      join(directory, "index.js"),
      `throw new Error("Standalone loaded project ${name} instead of its bundled runtime")`,
    )
  }
  run(["build", "initialized/index.circuit.tsx"])
  for (const concurrency of ["1", "2"])
    run(["build", "index.tsx", "--ignore-errors", "--concurrency", concurrency])
  await rm(join(projectDir, "node_modules"), { recursive: true })
  run(["build", "index.tsx", "--site", "--pcb-png", "--ignore-errors"])
  assert.equal(
    (await readFile(join(projectDir, "dist/index/pcb.png")))
      .subarray(1, 4)
      .toString(),
    "PNG",
  )
  assert.match(
    await readFile(join(projectDir, "dist/index.html"), "utf8"),
    /TSCIRCUIT_JSCDN_BASE_URL = ".\/jscdn"/,
  )

  const files = [
    ...new Bun.Glob("**/*").scanSync({ cwd: "build/jscdn", onlyFiles: true }),
  ]
  assert.deepEqual(
    files.filter((file) => file.endsWith("/manifold.wasm")),
    ["_assets/manifold.wasm"],
  )
  assert.deepEqual(
    files.filter((file) => file.endsWith("/occt-import-js.wasm")),
    ["_assets/occt-import-js.wasm"],
  )
  assert.deepEqual(
    files.filter((file) => file.endsWith("/occt-import-js.js")),
    ["_assets/occt-import-js.js"],
  )
  assert.ok(
    (await readFile("build/jscdn/occt-import-js/0.0.23/+esm")).length < 1024,
    "Viewer OCCT entry must be a wrapper, not another copy of the loader",
  )
  for (const file of files) {
    assert.deepEqual(
      await readFile(join(projectDir, "dist/jscdn", file)),
      await readFile(join("build/jscdn", file)),
    )
  }

  // Launch the actual compiled `tsci dev`; its environment must supply the CDN.
  const portProbe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = portProbe.port!
  portProbe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const devBinary = join(
    projectDir,
    process.platform === "win32" ? "tsci.exe" : "tsci",
  )
  await copyFile(binary, devBinary)
  dev = Bun.spawn([devBinary, "dev", "index.tsx", "--port", String(port)], {
    cwd: projectDir,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
    if (dev.exitCode !== null)
      throw new Error(`tsci dev exited with code ${dev.exitCode}`)
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) {
        const { event_list } = await (
          await fetch(`${origin}/api/events/list`, {
            signal: AbortSignal.timeout(1000),
          })
        ).json()
        if (
          event_list.some(
            (event: { event_type: string }) =>
              event.event_type === "INITIAL_FILES_UPLOADED",
          )
        ) {
          ready = true
          break
        }
      }
    } catch {}
    await Bun.sleep(100)
  }
  assert.ok(ready, "tsci dev did not start")
  const { file_list } = await (await fetch(`${origin}/api/files/list`)).json()
  assert.ok(
    !file_list.some(
      (file: { file_path: string }) =>
        file.file_path === "tsci" || file.file_path === "tsci.exe",
    ),
    "tsci dev must not upload its own executable",
  )
  const html = await (
    await fetch(origin, { signal: AbortSignal.timeout(1000) })
  ).text()
  assert.match(html, /TSCIRCUIT_JSCDN_BASE_URL = "\/jscdn"/)
  const datasheetApiUrl = html.match(
    /"TSCIRCUIT_DATASHEET_API_BASE_URL":"([^"]+)"/,
  )?.[1]
  assert.ok(datasheetApiUrl, "tsci dev must inject the baked datasheet API URL")
  const bakedAssetOrigin = new URL(datasheetApiUrl).origin
  assert.equal(new URL(bakedAssetOrigin).hostname, "127.0.0.1")
  const datasheetQuery = "datasheets/get/chip_name%3Drp2040.json"
  const bakedResponse = await fetch(
    `${datasheetApiUrl}/datasheets/get?chip_name=rp2040`,
  )
  assert.equal(bakedResponse.status, 200)
  assert.deepEqual(
    await bakedResponse.json(),
    await Bun.file(
      join("build/baked-asset-server/datasheet-api", datasheetQuery),
    ).json(),
  )
  assert.equal(
    (
      await fetch(
        `${datasheetApiUrl}/datasheets/get?chip_name=not-in-the-catalog`,
      )
    ).status,
    404,
  )
  const inventory = await Bun.file(
    "build/baked-asset-server/datasheet-api/datasheets/list",
  ).json()
  assert.deepEqual(
    await (await fetch(`${datasheetApiUrl}/datasheets/list`)).json(),
    inventory,
  )
  let sourceCount = 0
  for (const { datasheet_id } of inventory.datasheets) {
    const expected = await Bun.file(
      `build/baked-asset-server/datasheet-api/datasheets/get/datasheet_id%3D${datasheet_id}.json`,
    ).json()
    const response: Response = await fetch(
      `${datasheetApiUrl}/datasheets/get?datasheet_id=${datasheet_id}`,
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
    const source = expected.datasheet.generated_tsx
    assert.ok(source === null || typeof source === "string")
    if (source?.trim()) sourceCount++
  }
  // These BGA parts exercise the API source path, including a part excluded
  // from the compact footprint catalog. Imports must use the baked TSX as-is.
  for (const chipName of ["AM62L32", "AM3358BZCZA100"]) {
    assert.ok(
      search([chipName]).results.some((part) => part.chip_name === chipName),
      `${chipName} must remain discoverable in the complete baked inventory`,
    )
    const { datasheet } = await Bun.file(
      `build/baked-asset-server/datasheet-api/datasheets/get/chip_name%3D${chipName.toLowerCase()}.json`,
    ).json()
    assert.ok(datasheet.generated_tsx?.trim(), `${chipName} has no generated TSX`)
    run(["import", chipName])
    assert.equal(
      await readFile(join(projectDir, "imports", `${chipName}.tsx`), "utf8"),
      datasheet.generated_tsx,
    )
  }
  console.log(`Verified all ${inventory.datasheets.length} baked datasheets (${sourceCount} with TSX) and unchanged BGA imports.`)
  for (const file of files) {
    const response = await fetch(`${origin}/jscdn/${file}`, {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200, file)
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(join("build/jscdn", file)),
    )
    if (file.endsWith(".wasm"))
      assert.match(response.headers.get("content-type")!, /application\/wasm/)
  }

  console.log("Compiled build, site copy and tsci dev file checks passed")
  if (process.argv.includes("--browser")) {
    console.log("Launching Chromium")
    browser = await chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    })
    // Check the same modules below a nested static site as well as tsci dev.
    staticServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\/nested\//, "")
        const file = Bun.file(join(projectDir, "dist", path))
        return new Response(await file.arrayBuffer(), {
          headers: {
            "content-type": path.endsWith("+esm")
              ? "text/javascript"
              : file.type,
          },
        })
      },
    })
    const modules = files.filter(
      (file) => file.endsWith("+esm") || file.endsWith("/dist/browser.js"),
    )
    for (const base of [
      `${origin}/jscdn/`,
      `http://127.0.0.1:${staticServer.port}/nested/jscdn/`,
    ]) {
      console.log(`Checking browser imports at ${base}`)
      const page = await browser.newPage()
      const externalRequests: string[] = []
      await page.route("**/*", async (route) => {
        const url = route.request().url()
        if (!url.startsWith(new URL(base).origin)) {
          externalRequests.push(url)
          return route.abort()
        }
        if (url.endsWith("/test-page"))
          return route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><body>JS CDN smoke</body>",
          })
        return route.continue()
      })
      await page.goto(`${new URL(base).origin}/test-page`)
      await page.evaluate(
        async ({ base, modules, stepFixture }) => {
          for (const file of modules) {
            const namespace = await import(base + file)
            if (!Object.keys(namespace).length)
              throw new Error(`Empty module: ${file}`)
          }
          // Run a WASM-backed exporter, beyond merely downloading its loader.
          const { createFdmComponentBox } = await import(
            base + "circuit-json-to-fdm-component-box/latest/+esm"
          )
          const box = await createFdmComponentBox([
            {
              type: "source_component",
              source_component_id: "source_component_1",
              name: "R1",
              ftype: "simple_resistor",
              resistance: 1000,
            },
          ])
          if (box.threeMf[0] !== 80 || box.threeMf[1] !== 75)
            throw new Error("FDM exporter returned invalid 3MF")

          const { default: createManifold } = await import(
            base + "manifold-3d/3.5.1/manifold.js"
          )
          const manifold = await createManifold()
          manifold.setup()
          const cube = manifold.Manifold.cube([2, 3, 4])
          if (cube.volume() !== 24)
            throw new Error("Viewer Manifold runtime returned invalid geometry")
          cube.delete()

          const { default: createOcct } = await import(
            base + "occt-import-js/0.0.23/+esm"
          )
          const occt = await createOcct({
            locateFile: (path: string) =>
              base + "occt-import-js/0.0.23/dist/" + path,
          })
          if (typeof occt.ReadStepFile !== "function")
            throw new Error("Viewer STEP runtime did not initialize")
          const result = occt.ReadStepFile(
            new TextEncoder().encode(stepFixture),
            null,
          )
          if (!result.success || !result.meshes.length)
            throw new Error("Viewer STEP runtime did not produce geometry")
        },
        { base, modules, stepFixture },
      )
      assert.deepEqual(externalRequests, [])
      await page.close()
    }
    const context = await browser.newContext({ serviceWorkers: "block" })
    // Dev's parts panel can query the binary's separate baked-asset server.
    // Permit only that known loopback origin, never arbitrary external hosts.
    const allowedOrigins = new Set([origin, bakedAssetOrigin])
    const externalRequests: string[] = []
    const requests: string[] = []
    context.on("request", (request) => requests.push(request.url()))
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url())
      if (["http:", "https:"].includes(url.protocol) && !allowedOrigins.has(url.origin)) {
        externalRequests.push(url.href)
        return route.abort()
      }
      return route.continue()
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(origin)
    const fontLoaded = page.waitForResponse(
      (response) => response.url().endsWith("/kenpixel.ttf") && response.ok(),
    )
    await page.getByText("3D", { exact: true }).first().click()
    await page.waitForFunction(() =>
      Boolean(
        (window as any).__TSCIRCUIT_THREE_OBJECT?.getObjectByName("board-geom"),
      ),
    )
    await page.waitForFunction(() =>
      Boolean(
        (window as any).__TSCIRCUIT_THREE_OBJECT?.getObjectByName("StandaloneOcctFixture"),
      ),
    )
    await fontLoaded
    assert.ok(requests.some((url) => url.endsWith("/manifold.wasm")))
    assert.ok(requests.some((url) => url.endsWith("/kenpixel.ttf")))
    assert.ok(requests.some((url) => url.endsWith("/_assets/occt-import-js.js")))
    assert.ok(requests.some((url) => url.endsWith("/_assets/occt-import-js.wasm")))
    assert.deepEqual(errors, [])
    assert.deepEqual(externalRequests, [])
    await context.close()
    console.log(`3D board and STEP model rendered without external requests at ${origin}`)
  }
  console.log(
    `Shared CLI builds sites and serves ${files.length} embedded JS CDN files through tsci dev${browser ? "; all browser modules and WASM exporter work at dev and nested site URLs" : ""}.`,
  )
} finally {
  await browser?.close()
  staticServer?.stop(true)
  dev?.kill()
  if (dev) await dev.exited
  await rm(projectDir, { recursive: true, force: true })
}
