import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${item}`);
    }
    const key = item.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }

  return options;
}

export function resolveProjectPath(value) {
  return path.resolve(projectRoot, value);
}

export function statusFromResults(scenarios) {
  if (scenarios.some((scenario) => scenario.status === "fail")) {
    return "fail";
  }
  if (scenarios.some((scenario) => scenario.status === "warn")) {
    return "warn";
  }
  return "pass";
}

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function normalizeCommand(command) {
  return command === "node" ? process.execPath : command;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textFromToolResult(result) {
  const parts = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function createRunId() {
  return `run_${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "")}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function materializeTarget(target) {
  const paths = {};
  for (const [key, value] of Object.entries(target.paths ?? {})) {
    paths[key] = resolveProjectPath(value);
  }

  function interpolate(value) {
    if (typeof value !== "string") {
      return value;
    }
    let resolved = value.replace(/\$\{paths\.([A-Za-z0-9_-]+)\}/g, (match, key) => {
      if (!paths[key]) {
        throw new Error(`unknown target path variable: ${key}`);
      }
      return paths[key];
    });

    if (resolved.startsWith("node_modules/") || resolved.startsWith("fixtures/")) {
      resolved = resolveProjectPath(resolved);
    }
    return resolved;
  }

  return {
    ...target,
    command: normalizeCommand(target.command),
    args: (target.args ?? []).map(interpolate),
    cwd: resolveProjectPath(target.cwd ?? "."),
    resolvedPaths: paths,
    interpolate
  };
}

function materializeValue(value, target) {
  if (typeof value === "string") {
    return target.interpolate(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => materializeValue(item, target));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, materializeValue(item, target)])
    );
  }
  return value;
}

async function loadScenarios(scenariosDir) {
  const absoluteDir = path.resolve(process.cwd(), scenariosDir);
  const names = (await readdir(absoluteDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length === 0) {
    fail("no scenario JSON files found", { scenariosDir: absoluteDir });
  }
  return Promise.all(names.map(async (name) => {
    const scenario = await readJson(path.join(absoluteDir, name));
    scenario.sourceFile = path.join(absoluteDir, name);
    return scenario;
  }));
}

function validateTarget(target) {
  for (const field of ["id", "kind", "transport", "command", "args"]) {
    if (!(field in target)) {
      fail(`target config missing required field: ${field}`);
    }
  }
  if (target.kind !== "mcp") {
    fail("only MCP targets are supported in this POC", { kind: target.kind });
  }
  if (target.transport !== "stdio") {
    fail("only stdio transport is supported in this POC", { transport: target.transport });
  }
  if (!Array.isArray(target.args)) {
    fail("target args must be an array");
  }
}

function validateScenario(scenario) {
  for (const field of ["id", "title", "severity", "checks"]) {
    if (!(field in scenario)) {
      fail(`scenario config missing required field: ${field}`, { sourceFile: scenario.sourceFile });
    }
  }
  if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) {
    fail("scenario checks must be a non-empty array", { sourceFile: scenario.sourceFile });
  }
}

async function callToolExpectingFailure(client, request) {
  try {
    const result = await client.callTool(request);
    if (result?.isError) {
      return {
        failedAsExpected: true,
        mode: "mcp-error-result",
        text: textFromToolResult(result)
      };
    }
    return {
      failedAsExpected: false,
      mode: "unexpected-success",
      text: textFromToolResult(result)
    };
  } catch (error) {
    return {
      failedAsExpected: true,
      mode: "exception",
      text: error instanceof Error ? error.message : String(error)
    };
  }
}

function findTool(tools, name) {
  return tools.find((tool) => tool.name === name);
}

async function runCheck(check, context) {
  const { client, tools, target } = context;

  if (check.type === "mcp_list_tools") {
    const toolNames = tools.map((tool) => tool.name).sort();
    const missing = (check.expectedTools ?? []).filter((name) => !toolNames.includes(name));
    return {
      name: check.type,
      status: missing.length === 0 ? "pass" : "fail",
      expected: check.expectedTools,
      observed: toolNames,
      missing,
      reproduction: "agentgate validate --target targets/filesystem.mcp.json --scenarios scenarios/filesystem"
    };
  }

  if (check.type === "mcp_tool_schema_required") {
    const tool = findTool(tools, check.tool);
    const required = tool?.inputSchema?.required ?? [];
    const missing = (check.required ?? []).filter((name) => !required.includes(name));
    return {
      name: check.type,
      status: tool && missing.length === 0 ? "pass" : "fail",
      tool: check.tool,
      expectedRequired: check.required,
      observedRequired: required,
      missing,
      reproduction: `agentgate validate --target targets/filesystem.mcp.json --scenarios ${path.relative(projectRoot, path.dirname(context.scenario.sourceFile))}`
    };
  }

  if (check.type === "mcp_call_text_contains") {
    const args = materializeValue(check.arguments ?? {}, target);
    const result = await client.callTool({ name: check.tool, arguments: args });
    const text = textFromToolResult(result);
    const passed = text.includes(check.mustContain);
    return {
      name: check.type,
      status: passed ? "pass" : "fail",
      tool: check.tool,
      arguments: args,
      expectedContains: check.mustContain,
      observedText: text,
      reproduction: `call MCP tool ${check.tool} with ${JSON.stringify(args)}`
    };
  }

  if (check.type === "mcp_call_must_fail") {
    const args = materializeValue(check.arguments ?? {}, target);
    const result = await callToolExpectingFailure(client, { name: check.tool, arguments: args });
    const missingFailureText = check.failureTextContains && !result.text.includes(check.failureTextContains);
    const forbiddenHits = (check.mustNotContain ?? []).filter((item) => result.text.includes(item));
    const passed = result.failedAsExpected && !missingFailureText && forbiddenHits.length === 0;
    return {
      name: check.type,
      status: passed ? "pass" : "fail",
      tool: check.tool,
      arguments: args,
      mode: result.mode,
      expectedFailureText: check.failureTextContains,
      forbiddenHits,
      observedText: result.text,
      reproduction: `call MCP tool ${check.tool} with ${JSON.stringify(args)}`,
      risk: result.failedAsExpected ? undefined : "Tool call succeeded when failure was required."
    };
  }

  return {
    name: check.type ?? "unknown",
    status: "fail",
    error: `unknown check type: ${check.type}`
  };
}

async function runScenarios(client, target, scenarios) {
  const toolsResult = await client.listTools();
  const tools = toolsResult.tools ?? [];
  const results = [];

  for (const scenario of scenarios) {
    validateScenario(scenario);
    const checks = [];
    for (const check of scenario.checks) {
      checks.push(await runCheck(check, { client, tools, target, scenario }));
    }
    const status = checks.some((check) => check.status === "fail") ? "fail" : "pass";
    results.push({
      id: scenario.id,
      title: scenario.title,
      severity: scenario.severity,
      sourceFile: path.relative(projectRoot, scenario.sourceFile),
      status,
      checks
    });
  }

  return results;
}

function markdownReport(report) {
  const lines = [
    `# AgentGate Report: ${report.target.id}`,
    "",
    `Run ID: \`${report.run_id}\``,
    `Status: **${report.status.toUpperCase()}**`,
    `Target: \`${report.target.id}\``,
    `Started: ${report.started_at}`,
    `Finished: ${report.finished_at}`,
    "",
    "## Summary",
    "",
    `- Scenarios: ${report.summary.scenarios}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.status.toUpperCase()} ${scenario.id}`);
    lines.push("");
    lines.push(`Severity: \`${scenario.severity}\``);
    lines.push(`Source: \`${scenario.sourceFile}\``);
    lines.push("");
    for (const check of scenario.checks) {
      lines.push(`- ${check.status.toUpperCase()} \`${check.name}\``);
      if (check.reproduction) {
        lines.push(`  Reproduce: \`${check.reproduction}\``);
      }
      if (check.risk) {
        lines.push(`  Risk: ${check.risk}`);
      }
      if (check.observedText) {
        lines.push("  Evidence:");
        lines.push("");
        lines.push("  ```text");
        for (const line of check.observedText.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push("  ```");
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function htmlReport(report) {
  const scenarioRows = report.scenarios.map((scenario) => `
    <section class="scenario ${escapeHtml(scenario.status)}">
      <h2>${escapeHtml(scenario.status.toUpperCase())} ${escapeHtml(scenario.id)}</h2>
      <p><strong>Severity:</strong> ${escapeHtml(scenario.severity)}<br><strong>Source:</strong> ${escapeHtml(scenario.sourceFile)}</p>
      <ul>
        ${scenario.checks.map((check) => `
          <li>
            <strong>${escapeHtml(check.status.toUpperCase())}</strong> <code>${escapeHtml(check.name)}</code>
            ${check.reproduction ? `<div><small>Reproduce: <code>${escapeHtml(check.reproduction)}</code></small></div>` : ""}
            ${check.risk ? `<div><small>Risk: ${escapeHtml(check.risk)}</small></div>` : ""}
            ${check.observedText ? `<pre>${escapeHtml(check.observedText)}</pre>` : ""}
          </li>
        `).join("")}
      </ul>
    </section>
  `).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AgentGate Report ${escapeHtml(report.target.id)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #17202a; background: #f7f8fa; }
    main { max-width: 960px; margin: 0 auto; background: #fff; border: 1px solid #d8dee9; padding: 28px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { background: #111827; color: #f9fafb; padding: 12px; overflow: auto; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-weight: 700; }
    .pass .status, .scenario.pass h2 { color: #166534; }
    .fail .status, .scenario.fail h2 { color: #991b1b; }
    .scenario { border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 16px; }
  </style>
</head>
<body>
<main class="${escapeHtml(report.status)}">
  <h1>AgentGate Report</h1>
  <p><span class="status">${escapeHtml(report.status.toUpperCase())}</span></p>
  <p><strong>Run ID:</strong> <code>${escapeHtml(report.run_id)}</code><br>
  <strong>Target:</strong> <code>${escapeHtml(report.target.id)}</code><br>
  <strong>Started:</strong> ${escapeHtml(report.started_at)}<br>
  <strong>Finished:</strong> ${escapeHtml(report.finished_at)}</p>
  <h2>Summary</h2>
  <ul>
    <li>Scenarios: ${report.summary.scenarios}</li>
    <li>Passed: ${report.summary.passed}</li>
    <li>Failed: ${report.summary.failed}</li>
  </ul>
  ${scenarioRows}
</main>
</body>
</html>
`;
}

async function writeReports(outDir, report) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(outDir, "report.md"), markdownReport(report));
  await writeFile(path.join(outDir, "report.html"), htmlReport(report));
}

async function validate(options) {
  if (!options.target || !options.scenarios) {
    fail("usage: agentgate validate --target <target.json> --scenarios <dir> [--out <dir>] [--expect pass|warn|fail]");
  }

  const rawTarget = await readJson(path.resolve(process.cwd(), options.target));
  validateTarget(rawTarget);
  const target = materializeTarget(rawTarget);
  const scenarios = await loadScenarios(options.scenarios);
  const outDir = path.resolve(process.cwd(), options.out ?? "runs/latest");
  const startedAt = new Date().toISOString();
  const runId = createRunId();

  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args,
    cwd: target.cwd,
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`
    }
  });

  const client = new Client(
    { name: "agentgate-poc", version: "0.1.0" },
    { capabilities: {} }
  );

  let report;
  try {
    await client.connect(transport);
    const scenarioResults = await runScenarios(client, target, scenarios);
    const status = statusFromResults(scenarioResults);
    report = {
      run_id: runId,
      status,
      target: {
        id: rawTarget.id,
        kind: rawTarget.kind,
        transport: rawTarget.transport,
        command: target.command,
        args: target.args,
        cwd: target.cwd
      },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      summary: {
        scenarios: scenarioResults.length,
        passed: scenarioResults.filter((scenario) => scenario.status === "pass").length,
        failed: scenarioResults.filter((scenario) => scenario.status === "fail").length
      },
      scenarios: scenarioResults
    };
  } catch (error) {
    report = {
      run_id: runId,
      status: "fail",
      target: {
        id: rawTarget.id,
        kind: rawTarget.kind,
        transport: rawTarget.transport,
        command: target.command,
        args: target.args,
        cwd: target.cwd
      },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      summary: {
        scenarios: 0,
        passed: 0,
        failed: 1
      },
      scenarios: [],
      error: {
        message: error instanceof Error ? error.message : String(error),
        details: error?.details ?? {}
      }
    };
  } finally {
    await client.close().catch(() => {});
  }

  await writeReports(outDir, report);

  const reportPath = path.join(outDir, "report.html");
  console.log(`${report.status.toUpperCase()} ${rawTarget.id}`);
  console.log(`report: ${reportPath}`);

  if (options.expect) {
    if (options.expect === report.status) {
      console.log(`expected status matched: ${options.expect}`);
      return;
    }
    fail(`expected status ${options.expect}, observed ${report.status}`);
  }

  if (report.status === "fail") {
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command !== "validate") {
    fail("usage: agentgate validate --target <target.json> --scenarios <dir> [--out <dir>]");
  }
  await validate(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.details && Object.keys(error.details).length > 0) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exitCode = 1;
  });
}
