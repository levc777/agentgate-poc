# AgentGate POC

This is a small local proof of concept for **AgentGate**: a deterministic release gate for agent extensions.

The real-life demo tests an existing MCP server: the official filesystem MCP server published as `@modelcontextprotocol/server-filesystem`.

## Runtime

Use nvm from this project folder:

```bash
cd /Users/lev/worklib/levan_projects/mcp-qa-gate-poc
source ~/.nvm/nvm.sh
nvm install
nvm use
node --version
npm install
npm test
```

`.nvmrc` pins the project to Node 22, which satisfies the MCP packages' Node `>=18` requirement.

## How To Define The MCP Under Test

The target file is the contract:

```text
targets/filesystem.mcp.json
```

It defines:

- `kind`: currently `mcp`.
- `transport`: currently `stdio`.
- `command` and `args`: how to launch the MCP server.
- `cwd`: where the server command runs.
- `paths`: named fixture paths that scenarios can reference.

For another MCP server, create another `targets/*.mcp.json` with its launch command and safe fixture paths.

## How To Define Checks

Scenarios live here:

```text
scenarios/filesystem/*.scenario.json
```

Each scenario defines:

- `id`
- `title`
- `severity`
- `checks`

Current check types:

- `mcp_list_tools`
- `mcp_tool_schema_required`
- `mcp_call_text_contains`
- `mcp_call_must_fail`

## Run

```bash
npm run demo
```

Expected result:

```text
PASS official-filesystem-fixture
```

The run writes:

```text
runs/latest/report.json
runs/latest/report.md
runs/latest/report.html
```

## Real-Life Failure Demo

This intentionally misconfigures the official filesystem MCP root too broadly. AgentGate should catch that `outside-secret.txt` becomes readable.

```bash
npm run demo:unsafe
```

Expected result:

```text
FAIL official-filesystem-too-broad-root
expected status matched: fail
```

Report:

```text
runs/unsafe-demo/report.html
```

## Current Demo Checks

- Connects to the MCP server over stdio.
- Lists exposed tools.
- Verifies required tools exist.
- Verifies `read_text_file` requires `path`.
- Reads `hello.txt` inside the allowed fixture root.
- Attempts to read a file outside the allowed root and expects the server to block it.
- Verifies missing required arguments fail without a normal user-visible stack trace.

## Safety Boundary

This POC only uses local fixture files. It does not require secrets, network credentials, or production data.

## CI Shape

The gate command is:

```bash
npm run validate
```

It exits nonzero when any scenario fails.

## GitHub Actions Demo

This repo includes a demo workflow:

```text
.github/workflows/agentgate-demo.yml
```

The workflow runs on push, pull request, or manual dispatch. It installs Node from `.nvmrc`, runs `npm test`, and uploads both the passing and intentionally failing demo reports as an artifact named `agentgate-demo-reports`.

The important CI behavior is:

- the safe MCP target must pass;
- the unsafe target must fail for the expected reason;
- generated reports are retained as workflow artifacts.
