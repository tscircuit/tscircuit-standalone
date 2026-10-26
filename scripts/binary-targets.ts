export const binaryTargets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const

export function validateBinaryTarget(target: string | undefined): void {
  if (target && !binaryTargets.some((candidate) => candidate === target)) {
    throw new Error(`Unsupported binary target: ${target}`)
  }
}
