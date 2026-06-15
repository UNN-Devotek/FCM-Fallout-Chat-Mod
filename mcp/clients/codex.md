# FCM MCP — Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.fcm-dev]
command = "node"
args = ["mcp/dist/dev/index.js"]
env = { FCM_MCP_TOKEN = "<your-token>" }
```

Mint a token at https://dev.falloutchatmod.com → Profile → API Tokens.
