import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'
import { request } from 'node:https'
import type { Server } from 'node:https'
import { createCertificateAuthority, ipv6Bytes, issueServerCertificate } from './remote-tls'

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return address && typeof address !== 'string' ? address.port : 0
}

describe('the certificate authority a phone installs once', () => {
  const authority = createCertificateAuthority('Conductor Phone Access CA')

  it('is a CA certificate that signs only end-entity certificates', () => {
    const certificate = new X509Certificate(authority.certificatePem)
    expect(certificate.ca).toBe(true)
    expect(certificate.subject).toContain('Conductor Phone Access CA')
    expect(certificate.issuer).toBe(certificate.subject)
    expect(certificate.checkIssued(certificate)).toBe(true)
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    expect(certificate.keyUsage).toBeUndefined()
    expect(Date.parse(authority.notAfter) - Date.now()).toBeGreaterThan(9 * 365 * 86400000)
    expect(authority.fingerprint).toBe(certificate.fingerprint256)
  })

  it('issues a server certificate the CA vouches for, naming every address the listener answers on', () => {
    const issued = issueServerCertificate(authority, 'Conductor · MAIN', ['192.168.0.205', '100.72.193.87', 'fd7a:115c:a1e0::e138:c158', 'e-box.tail8216c8.ts.net', 'MAIN'])
    const leaf = new X509Certificate(issued.certificatePem)
    const ca = new X509Certificate(authority.certificatePem)
    expect(leaf.ca).toBe(false)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.issuer).toBe(ca.subject)
    expect(leaf.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(leaf.subjectAltName).toContain('IP Address:192.168.0.205')
    expect(leaf.subjectAltName).toContain('IP Address:100.72.193.87')
    expect(leaf.subjectAltName?.toUpperCase()).toContain('IP ADDRESS:FD7A:115C:A1E0:0:0:0:E138:C158')
    expect(leaf.subjectAltName).toContain('DNS:e-box.tail8216c8.ts.net')
    expect(leaf.subjectAltName).toContain('DNS:MAIN')
    expect(leaf.checkIP('192.168.0.205')).toBe('192.168.0.205')
    expect(leaf.checkHost('e-box.tail8216c8.ts.net')).toBe('e-box.tail8216c8.ts.net')
    expect(issued.hosts).toEqual(['localhost', '127.0.0.1', '192.168.0.205', '100.72.193.87', 'fd7a:115c:a1e0::e138:c158', 'e-box.tail8216c8.ts.net', 'MAIN'])
    // Apple refuses leaves valid for more than 398 days; keep well inside it.
    expect(Date.parse(issued.notAfter) - Date.now()).toBeLessThan(398 * 86400000)
    expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1')
  })

  it('completes a TLS handshake that a client trusting only the CA accepts', async () => {
    const issued = issueServerCertificate(authority, 'Conductor · MAIN', [])
    const server = createServer({ cert: issued.certificatePem + authority.certificatePem, key: issued.privateKeyPem, minVersion: 'TLSv1.2' },
      (_request, response) => { response.writeHead(200); response.end('ok') })
    try {
      const port = await listen(server)
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', ca: authority.certificatePem, rejectUnauthorized: true }, response => {
          let text = ''
          response.on('data', chunk => { text += String(chunk) })
          response.on('end', () => resolve(text))
        })
        req.once('error', reject)
        req.end()
      })
      expect(body).toBe('ok')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects a leaf signed by a different authority', () => {
    const other = createCertificateAuthority('Someone else')
    const issued = issueServerCertificate(other, 'Impostor', [])
    expect(new X509Certificate(issued.certificatePem).verify(new X509Certificate(authority.certificatePem).publicKey)).toBe(false)
  })
})

describe('IPv6 subject alternative names', () => {
  it('expands compressed addresses and rejects text that is not an address', () => {
    expect(ipv6Bytes('fd7a:115c:a1e0::e138:c158')?.toString('hex')).toBe('fd7a115ca1e0000000000000e138c158')
    expect(ipv6Bytes('::1')?.toString('hex')).toBe('00000000000000000000000000000001')
    expect(ipv6Bytes('[fe80::1%eth0]')?.toString('hex')).toBe('fe800000000000000000000000000001')
    expect(ipv6Bytes('::ffff:192.168.0.1')?.toString('hex')).toBe('00000000000000000000ffffc0a80001')
    expect(ipv6Bytes('192.168.0.1')).toBeNull()
    expect(ipv6Bytes('e-box.tail8216c8.ts.net')).toBeNull()
    expect(ipv6Bytes('1::2::3')).toBeNull()
  })
})
