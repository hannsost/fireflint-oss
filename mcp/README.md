# FireFlint MCP server

See the main [README](../README.md#mcp-server) for the full guide.


`mcp/` contains a dependency-free [Model Context Protocol](https://modelcontextprotocol.io) server (Node.js ≥ 20,
stdio transport) that exposes FireFlint's key operations to any MCP client — Claude, Codex, Cursor, LM Studio,
Grok Bot or your own agent running a local model.

### Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `fireflint_health` | read | Health, readiness and version |
| `fireflint_me` | read | Current user and memberships |
| `fireflint_list_websites` | read | Websites (delivery channels) of an org |
| `fireflint_list_content_types` | read | Content types and JSON schemas |
| `fireflint_list_content` | read | List/search content of a type |
| `fireflint_get_content` | read | One content object incl. revision |
| `fireflint_get_published` | read | Published content via delivery API |
| `fireflint_create_content` | write | Create a draft (validated) |
| `fireflint_update_content` | write | Update a draft with `expected_revision` |
| `fireflint_publish_content` | write | Publish a checked revision (human approval!) |

Write tools are hidden when `FIREFLINT_READ_ONLY=true`. Errors from the API are returned as tool errors
(`isError: true`) with the HTTP status, never with credentials.

### Configuration

All settings come from environment variables — **no secrets are stored in this repository**.

| Variable | Example | Required | Description |
| --- | --- | --- | --- |
| `FIREFLINT_BASE_URL` | `http://127.0.0.1:8090` | yes | FireFlint API base URL |
| `FIREFLINT_TOKEN` | `<access-token>` | one of | Admin API access token (Bearer) |
| `FIREFLINT_EMAIL / FIREFLINT_PASSWORD` | `<user> / <password>` | one of | Log in at startup via `/auth/login` instead of a token |
| `FIREFLINT_ORG_ID` | `<org-uuid>` | no | Default organisation for all tools |
| `FIREFLINT_DELIVERY_TOKEN` | `<delivery-token>` | no | Enables `fireflint_get_published` |
| `FIREFLINT_READ_ONLY` | `true` | no | Hide all write tools |

### Client setup

**Claude Desktop / Cursor / generic MCP JSON** (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "fireflint": {
      "command": "node",
      "args": ["/absolute/path/to/fireflint/mcp/src/server.mjs"],
      "env": {
        "FIREFLINT_BASE_URL": "http://127.0.0.1:8090",
        "FIREFLINT_TOKEN": "<access-token>",
        "FIREFLINT_ORG_ID": "<org-uuid>"
      }
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add fireflint --env FIREFLINT_BASE_URL=http://127.0.0.1:8090 --env FIREFLINT_TOKEN=<access-token> --env FIREFLINT_ORG_ID=<org-uuid> -- node /absolute/path/to/fireflint/mcp/src/server.mjs
```

**OpenAI Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.fireflint]
command = "node"
args = ["/absolute/path/to/fireflint/mcp/src/server.mjs"]
env = { FIREFLINT_BASE_URL = "http://127.0.0.1:8090", FIREFLINT_TOKEN = "<access-token>", FIREFLINT_ORG_ID = "<org-uuid>" }
```

**Run / test directly:**

```sh
cd mcp && npm test                       # unit tests against a mock API
FIREFLINT_BASE_URL=http://127.0.0.1:8090 node mcp/src/server.mjs   # speaks MCP on stdin/stdout
```

