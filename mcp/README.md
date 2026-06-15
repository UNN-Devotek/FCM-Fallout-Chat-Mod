# FCM MCP Server

stdio MCP server exposing FCM dev environment APIs to AI agents.

## Setup

1. Build:
   ```bash
   cd mcp
   npm install
   npm run build
   ```

2. Mint a token: visit https://dev.falloutchatmod.com → Profile → API Tokens.

3. Set the env var:
   ```bash
   export FCM_MCP_TOKEN=<your-token>
   ```

4. Wire your client — see `clients/` for per-client snippets:
   - [Claude Code](clients/claude-code.md)
   - [Codex](clients/codex.md)
   - [Antigravity](clients/antigravity.md)

## Tools

| Tool | Description |
|------|-------------|
| `fcm_health_get` | Backend health check |
| `fcm_version_get` | Backend version |
| `fcm_wiki_search` | Search Fallout 76 wiki |
| `fcm_camp_search` | Search camp listings |
| `fcm_channels_list` | List chat channels |
| `fcm_commands_list` | List slash commands |
| `fcm_messages_list` | List recent messages in a channel |
| `fcm_messages_send` | Send a message (confirm required) |
| `fcm_parties_list` | List active parties |
| `fcm_users_search` | Search users |
| `fcm_ws_snapshot` | WebSocket connection snapshot |
| `fcm_ws_count` | WebSocket connection count |
| `fcm_sim_stream_start` | Start message simulation (confirm required) |
| `fcm_sim_users_create` | Create simulated users (confirm required) |
| `fcm_releases_list` | List overlay releases |
