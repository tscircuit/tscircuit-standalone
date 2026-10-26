const replaceOnce = (source: string, original: string, replacement: string) => {
  if (source.split(original).length !== 2) {
    throw new Error(`Pinned CLI init source changed: ${original}`)
  }
  return source.replace(original, replacement)
}

export function adaptStandaloneInit(source: string) {
  source = replaceOnce(source, "const account = await fetchAccount()", "const account = null")
  return replaceOnce(
    source,
    "await setupTsciProject(projectDir, options?.install ? undefined : [])",
    "await setupTsciProject(projectDir, [])",
  )
}
