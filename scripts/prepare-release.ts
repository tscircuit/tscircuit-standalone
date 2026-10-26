import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

type Manifest = Record<string, unknown> & {
  dependencies?: Record<string, string>
}

export interface PrepareReleaseOptions {
  projectRoot?: string
  version?: string
  fetch?: (url: string) => Promise<Response>
  install?: false | ((projectRoot: string) => Promise<void>)
}

const isVersion = (value: unknown): value is string => {
  if (typeof value !== "string") return false
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      value,
    )
  if (!match) return false
  for (const identifiers of [match[4], match[5]]) {
    if (identifiers?.split(".").some((identifier) => !identifier)) return false
  }
  return !match[4]
    ?.split(".")
    .some(
      (identifier) =>
        /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier),
    )
}

const object = (
  value: unknown,
  description: string,
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`)
  }
  return value as Record<string, unknown>
}

const dependencyMinimum = (
  dependencies: Record<string, unknown>,
  name: string,
): string => {
  const range = dependencies[name]
  if (typeof range !== "string") {
    throw new Error(`tscircuit metadata is missing ${name}`)
  }
  const version = range.replace(/^[\^~]/, "")
  if (!isVersion(version) || !Bun.semver.satisfies(version, range)) {
    throw new Error(
      `Unsupported tscircuit dependency range for ${name}: ${range}`,
    )
  }
  return version
}

const installDependencies = async (projectRoot: string): Promise<void> => {
  const installation = Bun.spawn([process.execPath, "install"], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await installation.exited) !== 0) {
    throw new Error("Installing the selected tscircuit release failed")
  }
}

export async function prepareRelease(options: PrepareReleaseOptions = {}) {
  const projectRoot = options.projectRoot ?? resolve(import.meta.dir, "..")
  const requestedVersion = options.version ?? "latest"
  if (requestedVersion !== "latest" && !isVersion(requestedVersion)) {
    throw new Error(
      `Expected an exact tscircuit version or latest: ${requestedVersion}`,
    )
  }
  const response = await (options.fetch ?? fetch)(
    `https://registry.npmjs.org/tscircuit/${encodeURIComponent(requestedVersion)}`,
  )
  if (!response.ok) {
    throw new Error(
      `Fetching tscircuit metadata failed: HTTP ${response.status}`,
    )
  }
  const metadata = object(await response.json(), "tscircuit metadata")
  if (metadata.name !== "tscircuit" || !isVersion(metadata.version)) {
    throw new Error("Expected npm metadata for tscircuit with a valid version")
  }
  if (requestedVersion !== "latest" && metadata.version !== requestedVersion) {
    throw new Error(
      `Requested tscircuit ${requestedVersion}, received ${metadata.version}`,
    )
  }
  const dependencies = object(metadata.dependencies, "tscircuit dependencies")
  const coreVersion = dependencyMinimum(dependencies, "@tscircuit/core")
  const evalVersion = dependencyMinimum(dependencies, "@tscircuit/eval")
  const propsVersion = dependencyMinimum(dependencies, "@tscircuit/props")
  const packagePath = join(projectRoot, "package.json")
  const root = object(
    JSON.parse(await readFile(packagePath, "utf8")),
    "root manifest",
  ) as Manifest
  object(root.dependencies, "root dependencies")
  // Install the published package so its runtime dependency graph is retained.
  root.version = metadata.version
  root.dependencies = {
    ...root.dependencies,
    tscircuit: metadata.version,
  }
  await writeFile(packagePath, `${JSON.stringify(root, null, 2)}\n`)
  if (options.install !== false) {
    await (options.install ?? installDependencies)(projectRoot)
  }
  return { version: metadata.version, coreVersion, evalVersion, propsVersion }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  if (args.length > 1)
    throw new Error("Usage: bun scripts/prepare-release.ts [version|latest]")
  const release = await prepareRelease({ version: args[0] })
  console.log(
    `Prepared tscircuit ${release.version} (core ${release.coreVersion}, eval ${release.evalVersion}, props ${release.propsVersion})`,
  )
}
