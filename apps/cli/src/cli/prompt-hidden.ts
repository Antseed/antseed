/** Asks on the terminal without echoing; rejects with `noTerminal` when stdin is not one. */
export function promptHidden(question: string, noTerminal = 'No terminal to ask on.'): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) return Promise.reject(new Error(noTerminal))
  return new Promise((resolve, reject) => {
    process.stderr.write(question)
    let value = ''
    const wasRaw = input.isRaw
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const finish = (error?: Error) => {
      input.setRawMode(wasRaw)
      input.pause()
      input.removeListener('data', onData)
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish()
        if (char === '\u0003') return finish(new Error('Cancelled.'))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    input.on('data', onData)
  })
}
