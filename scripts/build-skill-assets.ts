import { unzipSync } from "fflate"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { writeEmbeddedAssets } from "./write-embedded-assets"

export const skillRevision = "ccfd1afbefa0d1fb0f995795e805030ee5e96de1"
const skillUrl = `https://codeload.github.com/tscircuit/skill/zip/${skillRevision}`

export async function buildSkillAssets(options: {
  fetch?: (url: string, options: RequestInit) => Promise<Response>
  outputDirectory?: string
  modulePath?: string
} = {}) {
  const directory = options.outputDirectory ?? resolve("build/skill")
  const modulePath = options.modulePath ?? resolve("lib/generated-skill-assets.ts")
  const response = await (options.fetch ?? fetch)(skillUrl, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Fetching pinned skill failed: HTTP ${response.status}`)
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const prefix = `skill-${skillRevision}/`
  const files = new Map<string, Uint8Array>()
  for (const [name, content] of Object.entries(archive)) {
    if (!name.startsWith(prefix)) throw new Error(`Unexpected skill archive path: ${name}`)
    const relative = name.slice(prefix.length)
    if (!relative || relative.endsWith("/")) continue
    const segments = relative.split("/")
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
      throw new Error(`Invalid skill archive path: ${name}`)
    }
    if (segments.some((segment) => segment.startsWith("."))) continue
    files.set(relative, content)
  }
  for (const name of ["SKILL.md", "LICENSE"]) {
    if (!files.get(name)?.length) throw new Error(`Pinned skill is missing ${name}`)
  }
  await mkdir(dirname(directory), { recursive: true })
  const staging = await mkdtemp(join(dirname(directory), ".skill-"))
  try {
    for (const [name, content] of files) {
      const destination = join(staging, name)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content)
    }
    await writeFile(join(staging, "SOURCE.json"), `${JSON.stringify({ repository: "tscircuit/skill", revision: skillRevision }, null, 2)}\n`)
    await rm(directory, { recursive: true, force: true })
    await rename(staging, directory)
    await writeEmbeddedAssets(directory, modulePath, "skillAssets")
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildSkillAssets()
