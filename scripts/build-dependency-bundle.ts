import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, readlink, lstat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { zipSync } from "fflate"

const portable = (name: string) => name.split(sep).join("/")

/** Package a hoisted, resolved tree. Runtime installation never runs scripts. */
export async function packDependencyBundle(project: string, output: string) {
  const modules = join(project, "node_modules")
  const projectPackage = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
  const manifest = {
    format: 1,
    starter: projectPackage.dependencies as Record<string, string>,
    packages: {} as Record<string, string>,
    files: {} as Record<string, { sha256: string; executable?: boolean }>,
    links: {} as Record<string, string>,
  }
  const files: Record<string, Uint8Array> = {}
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory)).sort()) {
      if (directory === modules && entry === ".cache") continue
      const full = join(directory, entry)
      const name = portable(relative(modules, full))
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) {
        // Hoisted installs use symlinks only for executable entrypoints.
        // Reject store/workspace links rather than shipping host paths.
        if (!name.split("/").includes(".bin")) throw new Error(`Nonportable package link: ${name}`)
        const target = portable(await readlink(full))
        const destination = portable(relative(modules, resolve(dirname(full), target)))
        if (destination.startsWith("../") || destination === ".." || target.includes(":")) throw new Error(`External package link: ${name}`)
        if (!(await lstat(resolve(dirname(full), target))).isFile()) throw new Error(`Executable link does not point to a file: ${name}`)
        manifest.links[name] = target
      } else if (stat.isDirectory()) {
        await visit(full)
      } else if (stat.isFile()) {
        const bytes = await readFile(full)
        files[`node_modules/${name}`] = bytes
        manifest.files[name] = {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...(stat.mode & 0o111 ? { executable: true } : {}),
        }
        if (/^(?:@[^/]+\/)?[^/]+\/package.json$/.test(name)) {
          const metadata = JSON.parse(bytes.toString())
          const packageName = name.slice(0, -"/package.json".length)
          manifest.packages[packageName] = metadata.version
        }
      } else {
        throw new Error(`Unsupported package file: ${name}`)
      }
    }
  }
  await visit(modules)
  for (const [name, version] of Object.entries(manifest.starter)) {
    if (manifest.packages[name] !== version) throw new Error(`Starter dependency is not exactly pinned: ${name}@${version}`)
  }
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest))
  // Keep the release's resolution evidence with the bundle.
  files["bun.lock"] = await readFile(join(project, "bun.lock"))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, zipSync(files, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") }))
  return manifest
}

export async function buildDependencyBundle() {
  const project = resolve("build/dependency-project")
  const output = resolve("build/dependencies.zip")
  const require = createRequire(resolve("package.json"))
  const dependencies: Record<string, string> = {}
  for (const name of ["tscircuit", "typescript", "react", "@types/react"]) {
    // tscircuit has an exports map, so locate its manifest from its entrypoint.
    let directory = dirname(require.resolve(name === "@types/react" ? `${name}/package.json` : name))
    while (true) {
      const metadata = await readFile(join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => null)
      if (metadata?.name === name) { dependencies[name] = metadata.version; break }
      const parent = dirname(directory)
      if (parent === directory) throw new Error(`Cannot locate installed ${name}`)
      directory = parent
    }
  }
  await mkdir(project, { recursive: true })
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "tsci-offline-starter", private: true, dependencies }, null, 2))
  // All supported platform optionals are included for cross-compiled releases.
  // Network access is confined to release preparation; no lifecycle scripts run.
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts", "--linker=hoisted", "--os=*", "--cpu=*"], {
    cwd: project, stdout: "inherit", stderr: "inherit",
  })
  if (await install.exited !== 0) throw new Error("Offline dependency bundle preparation failed")
  await packDependencyBundle(project, output)
  await writeFile("lib/generated-dependency-bundle.ts", '// @ts-nocheck -- Bun embeds this archive.\nimport dependencyBundle from "../build/dependencies.zip" with { type: "file" }\nexport { dependencyBundle }\n')
}

if (import.meta.main) await buildDependencyBundle()
