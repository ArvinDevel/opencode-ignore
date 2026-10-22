import { test, expect, describe, beforeAll } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import OpenCodeIgnore from "./index"

// Test data directory is the project root for all tests
const TEST_PROJECT_ROOT = path.join(process.cwd(), "test-data")

type Hook = (payload: any) => Promise<void> | void
type Hooks = Record<string, Hook[]>

const HOOK_META = {
  sessionID: "test",
  agent: "test",
  messageID: "test",
  id: "test",
}

function createContext(projectRoot: string) {
  const hooks: Hooks = {}

  const context = {
    location: {
      directory: projectRoot,
      project: { id: "test", directory: projectRoot, canonical: projectRoot },
    },
    tool: {
      hook: async (name: string, callback: Hook) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
    },
  }

  return { context, hooks }
}

// Helper to create plugin instance and collect registered hooks
async function createPlugin(projectRoot = TEST_PROJECT_ROOT): Promise<Hooks> {
  const { context, hooks } = createContext(projectRoot)
  await OpenCodeIgnore.setup(context as any)
  return hooks
}

async function run(hooks: Hooks, event: string, payload: Record<string, any>) {
  for (const hook of hooks[event] ?? []) {
    await hook(payload)
  }
}

// Helper to call the before hook
async function callHook(hooks: Hooks, tool: string, input: Record<string, unknown>) {
  await run(hooks, "execute.before", { ...HOOK_META, tool, input })
}

// Helper to call the after hook and return the mutated result
async function callAfterHook(hooks: Hooks, tool: string, input: Record<string, unknown>, result: any) {
  const payload = { ...HOOK_META, tool, input, status: "completed" as const, result }
  await run(hooks, "execute.after", payload)
  return payload.result
}

// Render result content the way a model would receive it
function textOf(result: any): string {
  const content = result.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((item: any) => item.type === "text" ? item.text : "").join("\n")
}

function globResult(entries: Array<{ path: string; type?: "file" | "directory" }>, metadata: Record<string, unknown> = {}) {
  return {
    output: entries.map((entry) => ({ path: entry.path, type: entry.type ?? "file" })),
    content: [{ type: "text", text: entries.map((entry) => entry.path).join("\n") }],
    metadata: { count: entries.length, truncated: false, ...metadata },
  }
}

function grepResult(matches: Array<{ path: string; line: number; text: string }>) {
  return {
    output: matches.map((match) => ({
      entry: { path: match.path, type: "file" as const },
      line: match.line,
      offset: 0,
      text: match.text,
      submatches: [],
    })),
    content: [{ type: "text", text: matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") }],
    metadata: { matches: matches.length, truncated: false },
  }
}

describe("OpenCodeIgnore Plugin", () => {
  test("exports a V2 plugin with id and setup", () => {
    expect(OpenCodeIgnore.id).toBe("opencode-ignore")
    expect(typeof OpenCodeIgnore.setup).toBe("function")
  })

  test("plugin loads and registers both hooks", async () => {
    const hooks = await createPlugin()
    expect(hooks["execute.before"]).toHaveLength(1)
    expect(hooks["execute.after"]).toHaveLength(1)
  })

  test("graceful degradation - missing ignore file allows all", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "opencode-ignore-none-"))
    try {
      const hooks = await createPlugin(tempDir)
      expect(callHook(hooks, "read", { path: "secrets.json" })).resolves.toBeUndefined()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("project root (.) is always allowed", async () => {
    const hooks = await createPlugin()

    expect(callHook(hooks, "read", { path: "." })).resolves.toBeUndefined()
    expect(callHook(hooks, "glob", { path: "." })).resolves.toBeUndefined()
    expect(callHook(hooks, "grep", { path: "." })).resolves.toBeUndefined()
  })
})

describe("Ignore File Loading", () => {
  test("uses .ignore when available", async () => {
    const hooks = await createPlugin()
    expect(callHook(hooks, "read", { path: "secrets.json" }))
      .rejects.toThrow(/Access denied/)
  })

  test("loads .ignore file correctly", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "opencode-ignore-rules-"))
    try {
      await writeFile(path.join(tempDir, ".ignore"), "blocked.txt\n")
      const hooks = await createPlugin(tempDir)

      expect(callHook(hooks, "read", { path: "blocked.txt" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hooks, "read", { path: "allowed.txt" }))
        .resolves.toBeUndefined()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("File I/O Tools Protection", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  describe("read tool", () => {
    test("allows access to allowed files", async () => {
      expect(callHook(hooks, "read", { path: "index.ts" })).resolves.toBeUndefined()
      expect(callHook(hooks, "read", { path: "README.md" })).resolves.toBeUndefined()
    })

    test("blocks secrets.json", async () => {
      expect(callHook(hooks, "read", { path: "secrets.json" }))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })

    test("blocks credentials.json", async () => {
      expect(callHook(hooks, "read", { path: "credentials.json" }))
        .rejects.toThrow(/Access denied.*credentials\.json/)
    })

    test("blocks .env files", async () => {
      expect(callHook(hooks, "read", { path: ".env" }))
        .rejects.toThrow(/Access denied.*\.env/)
      expect(callHook(hooks, "read", { path: ".env.local" }))
        .rejects.toThrow(/Access denied.*\.env\.local/)
      expect(callHook(hooks, "read", { path: "production.env" }))
        .rejects.toThrow(/Access denied.*production\.env/)
    })

    test("blocks certificate files", async () => {
      expect(callHook(hooks, "read", { path: "server.crt" }))
        .rejects.toThrow(/Access denied.*server\.crt/)
      expect(callHook(hooks, "read", { path: "ca.pem" }))
        .rejects.toThrow(/Access denied.*ca\.pem/)
      expect(callHook(hooks, "read", { path: "private.key" }))
        .rejects.toThrow(/Access denied.*private\.key/)
    })

    test("blocks id_rsa", async () => {
      expect(callHook(hooks, "read", { path: "id_rsa" }))
        .rejects.toThrow(/Access denied.*id_rsa/)
    })

    test("still accepts V1 filePath arguments", async () => {
      expect(callHook(hooks, "read", { filePath: "secrets.json" }))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("write tool", () => {
    test("allows writing to allowed files", async () => {
      expect(callHook(hooks, "write", { path: "output.txt" })).resolves.toBeUndefined()
    })

    test("blocks writing to secrets.json", async () => {
      expect(callHook(hooks, "write", { path: "secrets.json" }))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })
  })

  describe("edit tool", () => {
    test("allows editing allowed files", async () => {
      expect(callHook(hooks, "edit", { path: "index.ts" })).resolves.toBeUndefined()
    })

    test("blocks editing secrets.json", async () => {
      expect(callHook(hooks, "edit", { path: "secrets.json" }))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })
  })
})

describe("Search/List Tools Protection", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  describe("glob tool", () => {
    test("allows glob on project root", async () => {
      expect(callHook(hooks, "glob", { path: "." })).resolves.toBeUndefined()
    })

    test("allows glob on allowed directories", async () => {
      expect(callHook(hooks, "glob", { path: "src" })).resolves.toBeUndefined()
    })

    test("blocks glob on to/ignore (relative path)", async () => {
      expect(callHook(hooks, "glob", { path: "to/ignore" }))
        .rejects.toThrow(/Access denied.*to\/ignore/)
    })

    test("defaults to . when path not provided", async () => {
      expect(callHook(hooks, "glob", {})).resolves.toBeUndefined()
    })
  })

  describe("grep tool", () => {
    test("allows grep on project root", async () => {
      expect(callHook(hooks, "grep", { path: "." })).resolves.toBeUndefined()
    })

    test("allows grep on allowed directories", async () => {
      expect(callHook(hooks, "grep", { path: "src" })).resolves.toBeUndefined()
    })

    test("allows grep on bamboo-specs directory (pattern only blocks files inside)", async () => {
      // Pattern **/bamboo-specs/** blocks files inside, not the directory itself
      expect(callHook(hooks, "grep", { path: "foo/bamboo-specs" }))
        .resolves.toBeUndefined()
    })

    test("defaults to . when path not provided", async () => {
      expect(callHook(hooks, "grep", {})).resolves.toBeUndefined()
    })
  })

  describe("read tool on directories", () => {
    test("allows reading project root", async () => {
      expect(callHook(hooks, "read", { path: "." })).resolves.toBeUndefined()
    })

    test("allows reading allowed directories", async () => {
      expect(callHook(hooks, "read", { path: "src" })).resolves.toBeUndefined()
    })

    test("blocks reading /to/ignore", async () => {
      expect(callHook(hooks, "read", { path: "to/ignore" }))
        .rejects.toThrow(/Access denied.*to\/ignore/)
    })

    test("blocks reading sensitive-data files", async () => {
      expect(callHook(hooks, "read", { path: "sensitive-data/keys.json" }))
        .rejects.toThrow(/Access denied.*sensitive-data/)
    })
  })
})

describe("Pattern Types", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  describe("absolute patterns", () => {
    test("blocks /to/ignore files", async () => {
      expect(callHook(hooks, "read", { path: "to/ignore/file.txt" }))
        .rejects.toThrow(/Access denied/)
    })

    test("blocks /somedir/toignore/** files", async () => {
      expect(callHook(hooks, "read", { path: "somedir/toignore/nested/file.txt" }))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("glob patterns", () => {
    test("blocks **/bamboo-specs/** files", async () => {
      expect(callHook(hooks, "read", { path: "foo/bamboo-specs/plan.yml" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hooks, "read", { path: "bar/baz/bamboo-specs/config.xml" }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows bamboo-specs directory itself (only blocks files inside)", async () => {
      // Note: Pattern **/bamboo-specs/** blocks files inside, not the dir itself
      expect(callHook(hooks, "read", { path: "bamboo-specs" })).resolves.toBeUndefined()
    })

    test("blocks **/keycloak-realm-config/templates/** files", async () => {
      expect(callHook(hooks, "read", { path: "keycloak-realm-config/templates/realm.json" }))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("wildcard patterns", () => {
    test("blocks *-realm.json files", async () => {
      expect(callHook(hooks, "read", { path: "dev-realm.json" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hooks, "read", { path: "prod-realm.json" }))
        .rejects.toThrow(/Access denied/)
    })

    test("blocks some*.properties files", async () => {
      expect(callHook(hooks, "read", { path: "some.properties" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hooks, "read", { path: "something.properties" }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows other .properties files", async () => {
      expect(callHook(hooks, "read", { path: "test-data/sample.properties" })).resolves.toBeUndefined()
    })
  })

  describe("negation patterns", () => {
    test("allows *.local.json despite blocking patterns", async () => {
      expect(callHook(hooks, "read", { path: "config.local.json" })).resolves.toBeUndefined()
      expect(callHook(hooks, "read", { path: "settings.local.jsonc" })).resolves.toBeUndefined()
    })

    test("allows *.local.md files", async () => {
      expect(callHook(hooks, "read", { path: "notes.local.md" })).resolves.toBeUndefined()
    })

    test("allows /.local/ directory", async () => {
      expect(callHook(hooks, "read", { path: ".local" })).resolves.toBeUndefined()
      expect(callHook(hooks, "read", { path: ".local/impl.md" })).resolves.toBeUndefined()
    })

    test("blocks /somedir/toignore/** but allows file-to-not-ignore.md", async () => {
      expect(callHook(hooks, "read", { path: "somedir/toignore/file-to-not-ignore.md" }))
        .resolves.toBeUndefined()
      expect(callHook(hooks, "read", { path: "somedir/toignore/other-file.txt" }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows **/target/** due to negation", async () => {
      expect(callHook(hooks, "read", { path: "target/output.jar" })).resolves.toBeUndefined()
      expect(callHook(hooks, "read", { path: "target" })).resolves.toBeUndefined()
    })
  })
})

describe("Path Normalization", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  describe("absolute paths", () => {
    test("handles absolute paths correctly", async () => {
      const absolutePath = path.join(TEST_PROJECT_ROOT, "secrets.json")
      expect(callHook(hooks, "read", { path: absolutePath }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows absolute path to allowed file", async () => {
      const absolutePath = path.join(TEST_PROJECT_ROOT, "README.md")
      expect(callHook(hooks, "read", { path: absolutePath })).resolves.toBeUndefined()
    })
  })

  describe("./ prefix handling", () => {
    test("handles ./ prefix correctly", async () => {
      expect(callHook(hooks, "read", { path: "./secrets.json" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hooks, "read", { path: "./index.ts" })).resolves.toBeUndefined()
    })
  })

  describe("nested directories", () => {
    test("handles deeply nested paths", async () => {
      expect(callHook(hooks, "read", { path: "foo/bar/baz/bamboo-specs/plan.yml" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hooks, "read", { path: "deep/nested/path/allowed.txt" }))
        .resolves.toBeUndefined()
    })
  })

  describe("directory vs file matching", () => {
    test("directories get trailing slash for matching", async () => {
      // bamboo-specs/ as directory should be allowed (only files inside blocked)
      expect(callHook(hooks, "read", { path: "bamboo-specs" })).resolves.toBeUndefined()

      // Files inside bamboo-specs/ should be blocked
      expect(callHook(hooks, "read", { path: "bamboo-specs/file.txt" }))
        .rejects.toThrow(/Access denied/)
    })

    test(".local/ directory is allowed", async () => {
      expect(callHook(hooks, "read", { path: ".local" })).resolves.toBeUndefined()
      expect(callHook(hooks, "grep", { path: ".local" })).resolves.toBeUndefined()
    })
  })
})

describe("Edge Cases", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  test("handles undefined path gracefully", async () => {
    // Tools like glob/grep default to "." when no path provided
    expect(callHook(hooks, "glob", {})).resolves.toBeUndefined()
    expect(callHook(hooks, "grep", {})).resolves.toBeUndefined()
  })

  test("handles null/missing path for file tools", async () => {
    // Should not throw, just skip (no path to check)
    expect(callHook(hooks, "read", {})).resolves.toBeUndefined()
  })

  test("handles empty string path", async () => {
    expect(callHook(hooks, "read", { path: "" })).resolves.toBeUndefined()
    expect(callHook(hooks, "glob", { path: "" })).resolves.toBeUndefined()
  })

  test("ignores unsupported tools", async () => {
    // Tool that's not in extractPathsFromTool should be skipped
    expect(callHook(hooks, "unknown_tool", { somePath: "secrets.json" }))
      .resolves.toBeUndefined()
  })

  test("does not inspect shell commands", async () => {
    // Shell access is outside this plugin's scope; documented as a guardrail, not a sandbox
    expect(callHook(hooks, "shell", { command: "cat secrets.json" }))
      .resolves.toBeUndefined()
  })

  test("error message includes blocked path", async () => {
    try {
      await callHook(hooks, "read", { path: "secrets.json" })
      expect(false).toBe(true) // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain("secrets.json")
      expect(e.message).toContain("blocked by ignore file")
      expect(e.message).toContain("Access denied")
    }
  })
})

describe("Real-world Scenarios", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  test("allows normal development workflow", async () => {
    // Reading source files
    expect(callHook(hooks, "read", { path: "index.ts" })).resolves.toBeUndefined()
    expect(callHook(hooks, "read", { path: "README.md" })).resolves.toBeUndefined()

    // Writing output
    expect(callHook(hooks, "write", { path: "output.txt" })).resolves.toBeUndefined()

    // Searching codebase
    expect(callHook(hooks, "grep", { path: "src" })).resolves.toBeUndefined()
    expect(callHook(hooks, "glob", { path: "." })).resolves.toBeUndefined()
  })

  test("blocks sensitive files consistently", async () => {
    const sensitiveFiles = [
      "secrets.json",
      "credentials.json",
      ".env",
      ".env.production",
      "server.crt",
      "private.key",
      "id_rsa",
    ]

    for (const file of sensitiveFiles) {
      expect(callHook(hooks, "read", { path: file }))
        .rejects.toThrow(/Access denied/)
    }
  })

  test("handles complex project structure", async () => {
    // Should allow src directory
    expect(callHook(hooks, "read", { path: "src" })).resolves.toBeUndefined()

    // But block bamboo-specs inside any directory
    expect(callHook(hooks, "read", { path: "src/bamboo-specs/plan.yml" }))
      .rejects.toThrow(/Access denied/)
  })
})

describe("Glob Tool Result Filtering", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  test("filters blocked files from glob output", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, globResult([
      { path: "index.ts" },              // ALLOWED
      { path: "secrets.json" },          // BLOCKED
      { path: "credentials.json" },      // BLOCKED
      { path: "README.md" },             // ALLOWED
      { path: ".env" },                  // BLOCKED
      { path: "config.local.json" },     // ALLOWED (negation)
    ]))

    expect(result.output).toHaveLength(3)
    expect(result.output.map((entry: any) => entry.path)).toEqual([
      "index.ts",
      "README.md",
      "config.local.json",
    ])
    expect(result.metadata.count).toBe(3)
  })

  test("does not leak blocked paths through model content", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, globResult([
      { path: "index.ts" },
      { path: "secrets.json" },
      { path: ".env" },
    ]))

    const content = textOf(result)
    expect(content).toContain("index.ts")
    expect(content).not.toContain("secrets.json")
    expect(content).not.toContain(".env")
  })

  test("filters certificate and key files", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, globResult([
      { path: "server.crt" },
      { path: "private.key" },
      { path: "ca.pem" },
      { path: "README.md" },
    ]))

    expect(result.output).toHaveLength(1)
    expect(result.output[0].path).toBe("README.md")
  })

  test("returns empty output when all files blocked", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, globResult([
      { path: "secrets.json" },
      { path: "credentials.json" },
      { path: ".env" },
      { path: "private.key" },
    ]))

    expect(result.output).toEqual([])
    expect(textOf(result)).toBe("No files found")
  })

  test("handles glob results with no files", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*.xyz" }, globResult([]))

    expect(result.output).toEqual([])
    expect(textOf(result)).toBe("No files found")
  })

  test("preserves truncation notice", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, globResult(
      [{ path: "index.ts" }, { path: "secrets.json" }],
      { truncated: true },
    ))

    expect(textOf(result)).toContain("Results are truncated")
    expect(textOf(result)).not.toContain("secrets.json")
  })

  test("handles malformed glob results gracefully", async () => {
    const original = { output: null, content: [{ type: "text", text: "unchanged" }] }
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, original)

    expect(result).toBe(original)
  })

  test("respects negation patterns", async () => {
    const result = await callAfterHook(hooks, "glob", { pattern: "**/*" }, globResult([
      { path: "config.local.json" },      // ALLOWED (negation)
      { path: "settings.local.jsonc" },   // ALLOWED (negation)
      { path: ".local/impl.md" },         // ALLOWED (negation)
      { path: "secrets.json" },           // BLOCKED
    ]))

    expect(result.output).toHaveLength(3)
    expect(result.output.map((entry: any) => entry.path)).toContain("config.local.json")
    expect(result.output.map((entry: any) => entry.path)).toContain("settings.local.jsonc")
    expect(result.output.map((entry: any) => entry.path)).toContain(".local/impl.md")
  })

  test("does not filter non-glob tools", async () => {
    const original = globResult([{ path: "secrets.json" }, { path: "index.ts" }])
    const result = await callAfterHook(hooks, "read", {}, original)

    expect(result).toBe(original)
  })
})

describe("Grep Tool Result Filtering", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createPlugin()
  })

  test("filters blocked files from grep output", async () => {
    const result = await callAfterHook(hooks, "grep", { pattern: ".*" }, grepResult([
      { path: "index.ts", line: 10, text: "export" },                       // ALLOWED
      { path: "secrets.json", line: 3, text: "password" },                  // BLOCKED
      { path: "README.md", line: 1, text: "# opencode" },                   // ALLOWED
      { path: ".env", line: 5, text: "API_KEY=secret" },                    // BLOCKED
    ]))

    expect(result.output).toHaveLength(2)
    expect(result.output[0].entry.path).toBe("index.ts")
    expect(result.output[1].entry.path).toBe("README.md")
    expect(result.metadata.matches).toBe(2)
  })

  test("does not leak any info about blocked files", async () => {
    const result = await callAfterHook(hooks, "grep", { pattern: ".*" }, grepResult([
      { path: "credentials.json", line: 7, text: "admin_password: secret123" },
      { path: "private.key", line: 1, text: "-----BEGIN PRIVATE KEY-----" },
      { path: "index.ts", line: 50, text: "const config" },
    ]))

    // Only allowed file should remain
    expect(result.output).toHaveLength(1)
    expect(result.output[0].entry.path).toBe("index.ts")

    // Ensure no info from blocked files leaks
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("credentials.json")
    expect(serialized).not.toContain("private.key")
    expect(serialized).not.toContain("secret123")
    expect(serialized).not.toContain("PRIVATE KEY")
  })

  test("returns empty output when all matches blocked", async () => {
    const result = await callAfterHook(hooks, "grep", { pattern: "secret" }, grepResult([
      { path: "secrets.json", line: 1, text: "secret" },
      { path: ".env", line: 2, text: "password" },
      { path: "private.key", line: 5, text: "key data" },
    ]))

    expect(result.output).toEqual([])
    expect(textOf(result)).toBe("No matches found")
  })

  test("handles grep results with no matches", async () => {
    const result = await callAfterHook(hooks, "grep", { pattern: "nonexistent" }, grepResult([]))

    expect(result.output).toEqual([])
    expect(textOf(result)).toBe("No matches found")
  })

  test("handles malformed grep results gracefully", async () => {
    const original = { output: null, content: [{ type: "text", text: "unchanged" }] }
    const result = await callAfterHook(hooks, "grep", { pattern: "test" }, original)

    expect(result).toBe(original)
  })

  test("drops matches without a recognizable entry", async () => {
    const original = {
      output: [
        { entry: { path: "index.ts", type: "file" }, line: 10, offset: 0, text: "export", submatches: [] },
        { line: 5, text: "some match without file" },
        { entry: { path: "secrets.json", type: "file" }, line: 3, offset: 0, text: "password", submatches: [] },
      ],
      content: [{ type: "text", text: "unchanged" }],
    }
    const result = await callAfterHook(hooks, "grep", { pattern: ".*" }, original)

    expect(result.output).toHaveLength(1)
    expect(result.output[0].entry.path).toBe("index.ts")
    expect(textOf(result)).not.toContain("some match without file")
  })

  test("respects negation patterns in grep", async () => {
    const result = await callAfterHook(hooks, "grep", { pattern: ".*" }, grepResult([
      { path: "config.local.json", line: 1, text: "config" },   // ALLOWED (negation)
      { path: ".local/notes.md", line: 5, text: "notes" },      // ALLOWED (negation)
      { path: "secrets.json", line: 2, text: "secret" },        // BLOCKED
    ]))

    expect(result.output).toHaveLength(2)
    expect(result.output[0].entry.path).toBe("config.local.json")
    expect(result.output[1].entry.path).toBe(".local/notes.md")
  })

  test("does not filter non-grep tools", async () => {
    const original = grepResult([{ path: "secrets.json", line: 1, text: "secret" }])
    const result = await callAfterHook(hooks, "write", {}, original)

    expect(result).toBe(original)
  })
})
