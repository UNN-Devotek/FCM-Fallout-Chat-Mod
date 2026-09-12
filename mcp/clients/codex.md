# FCM MCP — Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.fcm-dev]
command = "node"
args = ["mcp/dist/dev/index.js"]
env = { FCM_MCP_TOKEN = "<your-token>" }
```

Mint a token at https://dev.falloutchatmod.com → Profile → API Tokens.

## Cloudflare API MCP (OAuth)

Cloudflare API access is configured globally for Codex at `~/.codex/config.toml`:

```toml
[mcp_servers.cloudflare]
url = "https://mcp.cloudflare.com/mcp"
oauth_resource = "https://mcp.cloudflare.com/mcp"
```

Do not commit Cloudflare tokens or OAuth credentials. Authenticate the configured server from the Codex CLI:

```bash
codex mcp login cloudflare
```

If the server is missing, add it once:

```bash
codex mcp add cloudflare --url https://mcp.cloudflare.com/mcp --oauth-resource https://mcp.cloudflare.com/mcp
```

Verify configuration and authentication:

```bash
codex mcp get cloudflare
codex mcp list
```

The first authenticated Cloudflare MCP call opens Cloudflare OAuth. Sign in, choose the minimum permissions needed for the requested operation, approve, then return to Codex. Cloudflare documents `https://mcp.cloudflare.com/mcp` as its official MCP endpoint and OAuth as the recommended connection method.
