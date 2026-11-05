// Exercise curl | sh with a real controlling terminal, including /dev/tty input.
export async function runInstallerInTerminal(
  command: string[], cwd: string, env: Record<string, string | undefined>,
  prompt: string, answer: string,
) {
  let output = ""
  let answered = false
  const child = Bun.spawn(command, {
    cwd, env,
    terminal: {
      cols: 120, rows: 24,
      data(terminal, bytes) {
        output += Buffer.from(bytes).toString()
        if (!answered && output.includes(prompt)) {
          answered = true
          terminal.write(`${answer}\n`)
        }
      },
    },
  })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    return { exitCode: await child.exited, output, answered }
  } finally {
    clearTimeout(timeout)
    child.terminal?.close()
  }
}
