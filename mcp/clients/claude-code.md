# FCM MCP — Claude Code

Add to your project `.mcp.json`:

```json
{
  "mcpServers": {
    "fcm-dev": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp/dist/dev/index.js"],
      "env": {
        "FCM_MCP_TOKEN": "<your-token>"
      }
    }
  }
}
```

Mint a token at https://dev.falloutchatmod.com → Profile → API Tokens.
