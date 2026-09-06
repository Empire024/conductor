import { createServer } from 'node:http'

const port = Number(process.argv[2] || 9370)
const hash = Buffer.alloc(64).toString('base64')
const manifest = [
  'version: 0.1.4',
  'files:',
  '  - url: Conductor-Setup-0.1.4.exe',
  `    sha512: ${hash}`,
  '    size: 1',
  'path: Conductor-Setup-0.1.4.exe',
  `sha512: ${hash}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n')

createServer((request, response) => {
  if (new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname === '/latest.yml') {
    response.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(manifest) })
    response.end(manifest)
    return
  }
  response.writeHead(404)
  response.end()
}).listen(port, '127.0.0.1', () => console.log(`Update smoke feed ready on ${port}`))
