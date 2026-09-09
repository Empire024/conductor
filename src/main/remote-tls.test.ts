import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'
import { connect } from 'node:tls'
import type { Server } from 'node:https'
import { createRemoteTlsIdentity, derInteger, tlsIdentityUsable } from './remote-tls'
import { resolveBindHost } from './remote-control-server'

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return address && typeof address !== 'string' ? address.port : 0
}

describe('the self-signed certificate the server presents', () => {
  it('parses as a v3 certificate covering loopback and the given addresses', () => {
    const identity = createRemoteTlsIdentity('Conductor · Desktop', ['192.168.1.20'])
    const certificate = new X509Certificate(identity.certificatePem)
    expect(certificate.subject).toContain('Conductor')
    expect(certificate.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(certificate.subjectAltName).toContain('IP Address:192.168.1.20')
    expect(certificate.subjectAltName).toContain('DNS:localhost')
    expect(identity.fingerprint).toBe(certificate.fingerprint256)
    expect(Date.parse(identity.notAfter)).toBeGreaterThan(Date.now())
  })

  it('actually completes a TLS handshake and is recognised by its pinned fingerprint', async () => {
    const identity = createRemoteTlsIdentity('Conductor · Desktop', [])
    const server = createServer({ cert: identity.certificatePem, key: identity.privateKeyPem, minVersion: 'TLSv1.2' },
      (_request, response) => { response.writeHead(200); response.end('{}') })
    try {
      const port = await listen(server)
      const presented = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
          resolve(socket.getPeerCertificate().fingerprint256)
          socket.destroy()
        })
        socket.once('error', reject)
      })
      expect(presented).toBe(identity.fingerprint)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('gives a different fingerprint every time, so pinning distinguishes machines', () => {
    expect(createRemoteTlsIdentity('a', []).fingerprint).not.toBe(createRemoteTlsIdentity('a', []).fingerprint)
  })

  it('replaces a stored certificate that is missing, malformed or close to expiry', () => {
    const identity = createRemoteTlsIdentity('Conductor', [])
    expect(tlsIdentityUsable(identity)).toBe(true)
    expect(tlsIdentityUsable({ ...identity, certificatePem: '' })).toBe(false)
    expect(tlsIdentityUsable({ ...identity, privateKeyPem: 'nonsense' })).toBe(false)
    expect(tlsIdentityUsable({ ...identity, notAfter: new Date(Date.now() + 86400000).toISOString() })).toBe(false)
    expect(tlsIdentityUsable({ ...identity, notAfter: 'not a date' })).toBe(false)
  })
})

describe('where the server binds', () => {
  it('stays on loopback unless the owner deliberately chooses network exposure', () => {
    expect(resolveBindHost({ exposure: 'loopback' })).toBe('127.0.0.1')
    expect(resolveBindHost({ exposure: 'network' })).toBe('0.0.0.0')
  })
})

describe('DER integer encoding of a certificate serial', () => {
  const hex = (value: number[]): string => derInteger(Buffer.from(value)).toString('hex')

  it('strips leading zeroes that OpenSSL rejects as illegal padding', () => {
    expect(hex([0x00, 0x05])).toBe('020105')
    expect(hex([0x00, 0x00, 0x05])).toBe('020105')
  })

  it('keeps the one zero byte that stops a high-bit value reading as negative', () => {
    expect(hex([0x00, 0x80])).toBe('02020080')
    expect(hex([0x80])).toBe('02020080')
    expect(hex([0x00, 0x00, 0xff, 0x01])).toBe('020300ff01')
  })

  it('encodes zero as a single byte rather than an empty or padded integer', () => {
    expect(hex([0x00])).toBe('020100')
    expect(hex([0x00, 0x00])).toBe('020100')
  })

  it('leaves an already-minimal value untouched', () => {
    expect(hex([0x02])).toBe('020102')
    expect(hex([0x7f, 0x11])).toBe('02027f11')
  })

  it('builds a certificate OpenSSL will parse across many random serials', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(() => new X509Certificate(createRemoteTlsIdentity('Render Desktop', []).certificatePem)).not.toThrow()
    }
  })
})
