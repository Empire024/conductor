// Synthetic PTY view fixture. Never invokes a provider or submits inference.
process.stdout.write('Synthetic native CLI · conversation ' + process.argv[2] + '\r\n> ')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (text) => { if (text.includes('\u0003')) process.exit(0); process.stdout.write(text) })
