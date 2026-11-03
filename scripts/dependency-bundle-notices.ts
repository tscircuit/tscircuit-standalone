import { unzipSync, strFromU8 } from "fflate"

/** Inventory packages copied as opaque ZIP bytes, outside Bun's module graph. */
export function dependencyBundleNotices(bytes: Uint8Array) {
  const notice = /^(?:licen[cs]e|copying|notice|copyright|third[_-]?party[_-]?notices?)(?:[._-].*)?$/i
  const packagePath = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/
  const files = unzipSync(bytes, { filter: (file) => packagePath.test(file.name) || notice.test(file.name.split("/").at(-1)!) })
  return Object.keys(files).filter((name) => packagePath.test(name)).sort().map((name) => {
    const root = name.slice(0, -"package.json".length)
    const metadata = JSON.parse(strFromU8(files[name]!))
    return {
      name: String(metadata.name), version: String(metadata.version),
      declaredLicense: metadata.license ?? metadata.licenses ?? null,
      repository: metadata.repository ?? null,
      root,
      notices: Object.keys(files).filter((file) => file.startsWith(root) && !file.slice(root.length).includes("node_modules/") && notice.test(file.split("/").at(-1)!)).sort().map((file) => ({ path: file, content: strFromU8(files[file]!) })),
    }
  })
}
