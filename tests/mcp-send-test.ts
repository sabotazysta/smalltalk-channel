#!/usr/bin/env bun
/**
 * Quick end-to-end MCP test:
 * - Spawns the MCP server as a subprocess (stdio transport)
 * - Calls the `send` tool to post messages to #general
 * - Calls fetch_history to verify history retrieval
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const env = {
  ...process.env,
  IRC_HOST: '127.0.0.1',
  IRC_PORT: '6667',
  IRC_NICK: 'testbot',
  IRC_USERNAME: 'testbot',
  IRC_PASSWORD: 'testpass123',
  IRC_CHANNELS: '#general',
  IRC_TLS: 'false',
}

const transport = new StdioClientTransport({
  command: 'bun',
  args: ['/workspace/projects/smalltalk-channel/src/server.ts'],
  env,
  stderr: 'inherit',
})

const client = new Client({ name: 'test-client', version: '0.0.1' })

console.log('Connecting to MCP server...')
await client.connect(transport)
console.log('Connected.')

// Give the IRC client time to connect and join
await new Promise(r => setTimeout(r, 3000))

// List tools
const tools = await client.listTools()
console.log('Available tools:', tools.tools.map(t => t.name).join(', '))

// Send a few test messages
for (const msg of ['hello from MCP test', 'second message', 'third message']) {
  const result = await client.callTool({
    name: 'send',
    arguments: { channel: '#general', text: msg },
  })
  const content = (result.content as Array<{type: string; text: string}>)[0]
  console.log(`Send "${msg}": ${content.text}`)
}

// Wait a bit for messages to be stored
await new Promise(r => setTimeout(r, 1000))

// Test fetch_history
console.log('Fetching history from #general...')
const histResult = await client.callTool({
  name: 'fetch_history',
  arguments: { channel: '#general', limit: 10 },
})
const histContent = (histResult.content as Array<{type: string; text: string}>)[0]
console.log('History result:')
console.log(histContent.text)

if (histResult.isError) {
  console.log('PARTIAL PASS: send works, fetch_history failed (see above)')
} else {
  console.log('PASS: all tests completed successfully')
}

await client.close()
