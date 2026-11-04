import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  lstat,
  stat,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import packageMetadata from "../package.json"

export interface CacheMetadata {
  bunVersion: string
  executableFiles: string[]
  links: Record<string, { target: string; directory: boolean }>
}

/** Archive native cache files and metadata verbatim; Bun still performs installation. */
export async function packBunCache(cache: string, output: string) {
  // Bun's index links use canonical absolute paths. macOS temporary paths and
  // Windows junctions may spell the same cache differently from the caller.
  cache = await realpath(cache)
  const files: Record<string, Uint8Array | string> = {}
  const metadata: CacheMetadata = {
    bunVersion: Bun.version,
    executableFiles: [],
    links: {},
  }
  const portable = (name: string) => name.split(sep).join("/")
  const visit = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name)
      const key = portable(relative(cache, full))
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        const absoluteTarget = await realpath(full)
        const target = portable(relative(dirname(full), absoluteTarget))
        const resolved = relative(cache, absoluteTarget)
        if (
          isAbsolute(resolved) ||
          resolved === ".." ||
          resolved.startsWith(`..${sep}`)
        ) {
          throw new Error(`Cache link escapes the cache: ${key}`)
        }
        metadata.links[key] = {
          target,
          directory: (await stat(full)).isDirectory(),
        }
      } else if (info.isDirectory()) {
        await visit(full)
      } else if (info.isFile()) {
        files[key] = await Bun.file(full).bytes()
        if (info.mode & 0o111) metadata.executableFiles.push(key)
      } else throw new Error(`Unsupported cache file: ${key}`)
    }
  }
  await visit(cache)
  files[".tsci-cache.json"] = JSON.stringify(metadata)
  await mkdir(dirname(output), { recursive: true })
  await Bun.Archive.write(output, files, { compress: "gzip" })
  const notices = []
  const noticeName =
    /^(?:licen[cs]e|copying|notice|copyright|third[_-]?party[_-]?notices?)(?:[._-].*)?$/i
  for (const [name, file] of Object.entries(files)) {
    if (!name.endsWith("/package.json") || typeof file === "string") continue
    const pkg = JSON.parse(new TextDecoder().decode(file))
    if (!pkg.name || !pkg.version) continue
    const root = name.slice(0, -"package.json".length)
    const packageNotices = []
    for (const [key, contents] of Object.entries(files)) {
      if (
        !key.startsWith(root) ||
        !noticeName.test(key.split("/").at(-1)!) ||
        typeof contents === "string"
      )
        continue
      packageNotices.push({
        path: key,
        content: new TextDecoder().decode(contents),
      })
    }
    notices.push({
      name: pkg.name,
      version: pkg.version,
      root,
      license: pkg.license ?? pkg.licenses ?? null,
      repository: pkg.repository ?? null,
      notices: packageNotices,
    })
  }
  await writeFile(`${output}.notices.json`, JSON.stringify(notices))
  return metadata
}

export async function buildBunCache() {
  const expected = (await Bun.file(".bun-version").text()).trim()
  if (Bun.version !== expected)
    throw new Error(`Build the cache with Bun ${expected}, got ${Bun.version}`)
  const staging = await mkdtemp(join(tmpdir(), "tsci-cache-build-"))
  const cache = join(staging, "cache")
  const output = resolve("build/bun-cache.tar.gz")
  const roots = [
    // Warm the exact requirements used by the unchanged CLI's init command,
    // including latest tags. Frozen cached metadata keeps future offline calls local.
    { tscircuit: "latest", typescript: "^5.0.0", "@types/react": "latest" },
    // Also include the selected runtime release for explicitly pinned projects.
    {
      tscircuit: packageMetadata.dependencies.tscircuit,
      typescript: packageMetadata.dependencies.typescript,
    },
  ]
  try {
    for (const [index, dependencies] of roots.entries()) {
      const project = join(staging, `seed-${index}`)
      await mkdir(project)
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ private: true, devDependencies: dependencies }),
      )
      const child = Bun.spawn(
        [process.execPath, "install", "--ignore-scripts", "--os=*", "--cpu=*"],
        {
          cwd: project,
          env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache },
          stdout: "inherit",
          stderr: "inherit",
        },
      )
      if ((await child.exited) !== 0)
        throw new Error("Failed to prepare Bun's native cache")
      await mkdir("build/bun-cache-locks", { recursive: true })
      await Bun.write(
        `build/bun-cache-locks/seed-${index}.lock`,
        Bun.file(join(project, "bun.lock")),
      )
    }
    await packBunCache(cache, output)
    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(output).arrayBuffer()))
      .digest("hex")
    await writeFile(
      "lib/generated-bun-cache.ts",
      `// @ts-nocheck -- generated embedded file import\nimport archive from "../build/bun-cache.tar.gz" with { type: "file" }\nexport const bunCache = { archive, id: ${JSON.stringify(digest)}, bunVersion: ${JSON.stringify(Bun.version)} }\n`,
    )
    console.log(
      `Prepared Bun ${Bun.version} cache (${Bun.file(output).size} compressed bytes)`,
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildBunCache()
