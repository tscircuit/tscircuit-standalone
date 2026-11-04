import { mkdir, readdir, realpath, lstat, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

export interface CacheMetadata {
  bunVersion: string
  executableFiles: string[]
  links: Record<string, { target: string; directory: boolean }>
}

/** Archive installed files verbatim, preserving portable links and executable modes. */
export async function packDirectory(cache: string, output: string) {
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
