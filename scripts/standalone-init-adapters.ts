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

export function adaptStandaloneSkillSetup(source: string) {
  return replaceOnce(source, "await downloadSkillRepo(targetDir)", `const skillDir = process.env.TSCIRCUIT_STANDALONE_SKILL_DIR
      if (!skillDir) throw new Error("Bundled tscircuit skill directory is missing")
      fs.cpSync(skillDir, targetDir, { recursive: true })`)
}
