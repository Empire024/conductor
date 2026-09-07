import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, relative } from 'node:path'
import type { ProjectRecord } from '../shared/models'
import { resolveWithinProject } from './project-paths'

// A loopback-only browser surface. Capability URLs expose only registered project files;
// no Conductor preload, directory listing, or application IPC is available here.
export class ProjectPreviewServer {
  private server: Server | null = null
  private port = 0
  private starting: Promise<void> | null = null
  private roots = new Map<string, string>()
  private tokens = new Map<string, string>()
  async url(project: ProjectRecord, requested: string): Promise<string> {
    const target = resolveWithinProject(project.path, requested)
    const [root, file] = await Promise.all([fs.realpath(project.path), fs.realpath(target)])
    resolveWithinProject(root, relative(root, file))
    if (!(await fs.stat(file)).isFile()) throw new Error('Only files can be opened in a browser')
    if (!this.starting) this.starting = new Promise<void>((resolve, reject) => {
      this.server = createServer((request, response) => { void (async () => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        const [, token, ...parts] = pathname.split('/')
        const root = this.roots.get(token ?? '')
        if (!root || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404).end(); return }
        const decoded = parts.map(decodeURIComponent).join('/')
        const canonicalRoot = await fs.realpath(root)
        const file = await fs.realpath(resolveWithinProject(root, decoded))
        resolveWithinProject(canonicalRoot, relative(canonicalRoot, file))
        const stat = await fs.stat(file)
        if (!stat.isFile()) { response.writeHead(404).end(); return }
        const mime = ({ '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' } as Record<string, string>)[extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8'
        response.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
        if (request.method === 'HEAD') response.end()
        else createReadStream(file).on('error', () => response.destroy()).pipe(response)
      })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end() }) })
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        if (!address || typeof address === 'string') { reject(new Error('Could not start file preview')); return }
        this.port = address.port; resolve()
      })
    })
    await this.starting
    let token = this.tokens.get(project.id)
    if (!token) { token = randomUUID(); this.tokens.set(project.id, token) }
    this.roots.set(token, project.path)
    return 'http://127.0.0.1:' + this.port + '/' + token + '/' + relative(project.path, target).split(/[\\/]/).map(encodeURIComponent).join('/')
  }
  close(): void { this.server?.closeAllConnections(); this.server?.close(); this.server = null; this.roots.clear() }
}
