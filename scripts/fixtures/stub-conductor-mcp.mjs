// A stdio MCP server named like Conductor's own ("conductor") that offers request_permission and
// list_permissions and answers them harmlessly. scripts/probe-request-permission-exempt.mjs points a
// headless claude at it to see who decides the call: an allow rule or the auto-mode classifier.
import { createInterface } from 'node:readline'

const tools = [
  { name: 'request_permission', description: 'Ask the owner to approve one exact call (command, path or url). It only files a request card; it runs nothing.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' }, reason: { type: 'string' }, rollback: { type: 'string' } }, required: ['reason'] } },
  { name: 'list_permissions', description: 'List this conversation\'s permission requests and grants.', inputSchema: { type: 'object', properties: {} } }
]
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'conductor', version: '1' } } })
  else if (method === 'tools/list') send({ id, result: { tools } })
  else if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: params?.name === 'request_permission' ? 'STUB REQUEST FILED: the owner sees a card; nothing ran.' : 'STUB: no requests or grants.' }] } })
  else send({ id, error: { code: -32601, message: `unknown method ${method}` } })
})
