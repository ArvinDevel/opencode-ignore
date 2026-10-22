import {test, expect, describe, beforeAll} from "bun:test"
import OpenCodeIgnore from "./index"
import path from "path"
import os from "node:os"
import {mkdtemp, rm, writeFile} from "node:fs/promises"

// Test data directory is the project root for all tests
const TEST_PROJECT_ROOT = path.join(process.cwd(), "test-data")

type PluginContext = Parameters<typeof OpenCodeIgnore.setup>[0]
type HookCallback = (event: Record<string, unknown>) => Promise<unknown>
type Hooks = Record<string, HookCallback>

// Helper to register the plugin against a mock V2 plugin context
async function createHooks(directory = TEST_PROJECT_ROOT, canonical = directory): Promise<Hooks> {
  const hooks: Hooks = {}
  const ctx = {
    location: {
      directory,
      project: {id: "test-project", directory, canonical},
    },
    options: {},
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        hooks[name] = callback
        return {dispose: async () => {}}
      },
    },
  } as unknown as PluginContext

  await OpenCodeIgnore.setup(ctx)
  return hooks
}

// Helper to call the execute.before hook with V2 event shape
async function callBefore(hooks: Hooks, tool: string, input: Record<string, unknown> = {}) {
  await hooks["execute.before"]!({
    tool,
    input,
    sessionID: "test-session",
    agent: "build",
    messageID: "test-message",
    id: "test-call",
  })
}

// Helper to call the execute.after hook with a completed V2 tool result
async function callAfter(hooks: Hooks, tool: string, input: Record<string, unknown>, output: unknown, metadata?: Record<string, unknown>) {
  const event: Record<string, unknown> = {
    tool,
    input,
    sessionID: "test-session",
    agent: "build",
    messageID: "test-message",
    id: "test-call",
    status: "completed",
    result: metadata === undefined ? {output} : {output, metadata},
  }
  await hooks["execute.after"]!(event)
  return event.result as {output?: unknown; metadata?: Record<string, unknown>}
}

// Absolute path helper for V2 glob/grep output fixtures (they emit absolute paths)
const abs = (targetPath: string) => path.join(TEST_PROJECT_ROOT, targetPath)

describe("Plugin loading", () => {
  test("exposes a V2 plugin definition with a stable id", () => {
    expect(OpenCodeIgnore.id).toBe("opencode-ignore")
    expect(typeof OpenCodeIgnore.setup).toBe("function")
  })

  test("registers execute.before and execute.after tool hooks", async () => {
    const hooks = await createHooks()
    expect(typeof hooks["execute.before"]).toBe("function")
    expect(typeof hooks["execute.after"]).toBe("function")
  })

  test("graceful degradation - missing ignore file allows all", async () => {
    const tempDir = "/tmp/test-no-ignore-" + Date.now()
    const hooks = await createHooks(tempDir)

    // Should not throw even though no ignore file exists
    await expect(callBefore(hooks, "read", {path: "secrets.json"})).resolves.toBeUndefined()
  })

  test("project root (.) is always allowed", async () => {
    const hooks = await createHooks()

    // All operations on the root should be allowed
    await expect(callBefore(hooks, "read", {path: "."})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "glob", {path: "."})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "grep", {path: "."})).resolves.toBeUndefined()
  })
})

describe("Ignore File Loading", () => {
  test("uses .ignore when available", async () => {
    const hooks = await createHooks()

    await expect(callBefore(hooks, "read", {path: "secrets.json"}))
      .rejects.toThrow(/Access denied/)
  })

  test("loads .ignore file correctly", async () => {
    const tempDir = "/tmp/test-ignore-" + Date.now()
    await Bun.write(tempDir + "/.ignore", "blocked.txt\n")

    const hooks = await createHooks(tempDir)

    await expect(callBefore(hooks, "read", {path: "blocked.txt"}))
      .rejects.toThrow(/Access denied/)
    await expect(callBefore(hooks, "read", {path: "allowed.txt"}))
      .resolves.toBeUndefined()
  })

  test("does not require the Bun global (desktop app)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-ignore-desktop-"))
    const original = Bun.file

    try {
      await writeFile(path.join(tempDir, ".ignore"), "blocked.txt\n")
      const hooks = await createHooks(tempDir)

      // The desktop app does not expose the Bun global; any use of Bun.file
      // must fail the way it does there.
      Bun.file = (() => {
        throw new ReferenceError("Bun is not defined")
      }) as typeof Bun.file

      await expect(callBefore(hooks, "read", {path: "blocked.txt"}))
        .rejects.toThrow(/Access denied/)
    } finally {
      Bun.file = original
      await rm(tempDir, {recursive: true, force: true})
    }
  })

  test("discovers .ignore upward when started in a subdirectory", async () => {
    const parent = "/tmp/test-ignore-parent-" + Date.now()
    await Bun.write(parent + "/.ignore", "blocked.txt\n")
    await Bun.write(parent + "/sub/keep.txt", "content\n")

    const hooks = await createHooks(parent + "/sub", parent)

    await expect(callBefore(hooks, "read", {path: "blocked.txt"}))
      .rejects.toThrow(/Access denied/)
    await expect(callBefore(hooks, "read", {path: "keep.txt"}))
      .resolves.toBeUndefined()
  })

  test("does not search above the canonical project root", async () => {
    const parent = "/tmp/test-ignore-bound-" + Date.now()
    await Bun.write(parent + "/.ignore", "blocked.txt\n")
    await Bun.write(parent + "/inner/deep/readme.md", "content\n")

    // .ignore sits above the canonical root, so it must not be loaded
    const hooks = await createHooks(parent + "/inner/deep", parent + "/inner")

    await expect(callBefore(hooks, "read", {path: "blocked.txt"}))
      .resolves.toBeUndefined()
  })
})

describe("File I/O Tools Protection", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  describe("read tool", () => {
    test("allows access to allowed files", async () => {
      await expect(callBefore(hooks, "read", {path: "index.ts"})).resolves.toBeUndefined()
      await expect(callBefore(hooks, "read", {path: "README.md"})).resolves.toBeUndefined()
    })

    test("blocks secrets.json", async () => {
      await expect(callBefore(hooks, "read", {path: "secrets.json"}))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })

    test("blocks credentials.json", async () => {
      await expect(callBefore(hooks, "read", {path: "credentials.json"}))
        .rejects.toThrow(/Access denied.*credentials\.json/)
    })

    test("blocks .env files", async () => {
      await expect(callBefore(hooks, "read", {path: ".env"}))
        .rejects.toThrow(/Access denied.*\.env/)
      await expect(callBefore(hooks, "read", {path: ".env.local"}))
        .rejects.toThrow(/Access denied.*\.env\.local/)
      await expect(callBefore(hooks, "read", {path: "production.env"}))
        .rejects.toThrow(/Access denied.*production\.env/)
    })

    test("blocks certificate files", async () => {
      await expect(callBefore(hooks, "read", {path: "server.crt"}))
        .rejects.toThrow(/Access denied.*server\.crt/)
      await expect(callBefore(hooks, "read", {path: "ca.pem"}))
        .rejects.toThrow(/Access denied.*ca\.pem/)
      await expect(callBefore(hooks, "read", {path: "private.key"}))
        .rejects.toThrow(/Access denied.*private\.key/)
    })

    test("blocks id_rsa", async () => {
      await expect(callBefore(hooks, "read", {path: "id_rsa"}))
        .rejects.toThrow(/Access denied.*id_rsa/)
    })

    test("blocks listing a directory matched by a directory-only pattern", async () => {
      const tempDir = "/tmp/test-dirol-" + Date.now()
      await Bun.write(tempDir + "/.ignore", "secret-dir/\n")
      await Bun.write(tempDir + "/secret-dir/inside.txt", "content\n")

      const dirHooks = await createHooks(tempDir)
      await expect(callBefore(dirHooks, "read", {path: "secret-dir"}))
        .rejects.toThrow(/Access denied.*secret-dir/)
      await expect(callBefore(dirHooks, "read", {path: "secret-dir/inside.txt"}))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("write tool", () => {
    test("allows writing to allowed files", async () => {
      await expect(callBefore(hooks, "write", {path: "output.txt"})).resolves.toBeUndefined()
    })

    test("blocks writing to secrets.json", async () => {
      await expect(callBefore(hooks, "write", {path: "secrets.json"}))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })
  })

  describe("edit tool", () => {
    test("allows editing allowed files", async () => {
      await expect(callBefore(hooks, "edit", {path: "index.ts"})).resolves.toBeUndefined()
    })

    test("blocks editing secrets.json", async () => {
      await expect(callBefore(hooks, "edit", {path: "secrets.json"}))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })
  })

  describe("patch tool", () => {
    test("allows patches touching allowed files", async () => {
      const patchText = ["*** Begin Patch", "*** Update File: index.ts", "@@", "-old", "+new", "*** End Patch"].join("\n")
      await expect(callBefore(hooks, "patch", {patchText})).resolves.toBeUndefined()
    })

    test("blocks patches touching blocked files", async () => {
      const patchText = ["*** Begin Patch", "*** Update File: secrets.json", "@@", "-old", "+new", "*** End Patch"].join("\n")
      await expect(callBefore(hooks, "patch", {patchText}))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })

    test("blocks patches that delete blocked files", async () => {
      const patchText = ["*** Begin Patch", "*** Delete File: credentials.json", "*** End Patch"].join("\n")
      await expect(callBefore(hooks, "patch", {patchText}))
        .rejects.toThrow(/Access denied.*credentials\.json/)
    })

    test("blocks patches that move a blocked file", async () => {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: allowed.txt",
        "*** Move to: backup/credentials.json",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n")
      // Blocked by the move target (credentials.json pattern)
      await expect(callBefore(hooks, "patch", {patchText}))
        .rejects.toThrow(/Access denied/)
    })
  })
})

describe("Search Tools Protection", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  describe("glob tool", () => {
    test("allows glob on project root", async () => {
      await expect(callBefore(hooks, "glob", {path: "."})).resolves.toBeUndefined()
    })

    test("allows glob on allowed directories", async () => {
      await expect(callBefore(hooks, "glob", {path: "src"})).resolves.toBeUndefined()
    })

    test("blocks glob on to/ignore (relative path)", async () => {
      await expect(callBefore(hooks, "glob", {path: "to/ignore"}))
        .rejects.toThrow(/Access denied.*to\/ignore/)
    })

    test("defaults to . when path not provided", async () => {
      await expect(callBefore(hooks, "glob", {})).resolves.toBeUndefined()
    })
  })

  describe("grep tool", () => {
    test("allows grep on project root", async () => {
      await expect(callBefore(hooks, "grep", {path: "."})).resolves.toBeUndefined()
    })

    test("allows grep on allowed directories", async () => {
      await expect(callBefore(hooks, "grep", {path: "src"})).resolves.toBeUndefined()
    })

    test("allows grep on bamboo-specs directory (pattern only blocks files inside)", async () => {
      // Pattern **/bamboo-specs/** blocks files inside, not the directory itself
      await expect(callBefore(hooks, "grep", {path: "foo/bamboo-specs"})).resolves.toBeUndefined()
    })

    test("defaults to . when path not provided", async () => {
      await expect(callBefore(hooks, "grep", {})).resolves.toBeUndefined()
    })
  })

  describe("read tool on directories (V2 replaced list)", () => {
    test("allows reading the project root", async () => {
      await expect(callBefore(hooks, "read", {path: "."})).resolves.toBeUndefined()
    })

    test("allows reading allowed directories", async () => {
      await expect(callBefore(hooks, "read", {path: "src"})).resolves.toBeUndefined()
    })

    test("blocks reading /to/ignore", async () => {
      await expect(callBefore(hooks, "read", {path: "to/ignore"}))
        .rejects.toThrow(/Access denied.*to\/ignore/)
    })

    test("defaults are skipped when path not provided", async () => {
      await expect(callBefore(hooks, "read", {})).resolves.toBeUndefined()
    })
  })
})

describe("Pattern Types", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  describe("absolute patterns", () => {
    test("blocks /to/ignore files", async () => {
      await expect(callBefore(hooks, "read", {path: "to/ignore/file.txt"}))
        .rejects.toThrow(/Access denied/)
    })

    test("blocks /somedir/toignore/** files", async () => {
      await expect(callBefore(hooks, "read", {path: "somedir/toignore/nested/file.txt"}))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("glob patterns", () => {
    test("blocks **/bamboo-specs/** files", async () => {
      await expect(callBefore(hooks, "read", {path: "foo/bamboo-specs/plan.yml"}))
        .rejects.toThrow(/Access denied/)
      await expect(callBefore(hooks, "read", {path: "bar/baz/bamboo-specs/config.xml"}))
        .rejects.toThrow(/Access denied/)
    })

    test("allows bamboo-specs directory itself (only blocks files inside)", async () => {
      await expect(callBefore(hooks, "read", {path: "bamboo-specs"})).resolves.toBeUndefined()
    })

    test("blocks **/keycloak-realm-config/templates/** files", async () => {
      await expect(callBefore(hooks, "read", {path: "keycloak-realm-config/templates/realm.json"}))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("wildcard patterns", () => {
    test("blocks *-realm.json files", async () => {
      await expect(callBefore(hooks, "read", {path: "dev-realm.json"}))
        .rejects.toThrow(/Access denied/)
      await expect(callBefore(hooks, "read", {path: "prod-realm.json"}))
        .rejects.toThrow(/Access denied/)
    })

    test("blocks some*.properties files", async () => {
      await expect(callBefore(hooks, "read", {path: "some.properties"}))
        .rejects.toThrow(/Access denied/)
      await expect(callBefore(hooks, "read", {path: "something.properties"}))
        .rejects.toThrow(/Access denied/)
    })

    test("allows other .properties files", async () => {
      await expect(callBefore(hooks, "read", {path: "test-data/sample.properties"})).resolves.toBeUndefined()
    })
  })

  describe("negation patterns", () => {
    test("allows *.local.json despite blocking patterns", async () => {
      await expect(callBefore(hooks, "read", {path: "config.local.json"})).resolves.toBeUndefined()
      await expect(callBefore(hooks, "read", {path: "settings.local.jsonc"})).resolves.toBeUndefined()
    })

    test("allows *.local.md files", async () => {
      await expect(callBefore(hooks, "read", {path: "notes.local.md"})).resolves.toBeUndefined()
    })

    test("allows /.local/ directory", async () => {
      await expect(callBefore(hooks, "read", {path: ".local"})).resolves.toBeUndefined()
      await expect(callBefore(hooks, "read", {path: ".local/impl.md"})).resolves.toBeUndefined()
    })

    test("blocks /somedir/toignore/** but allows file-to-not-ignore.md", async () => {
      await expect(callBefore(hooks, "read", {path: "somedir/toignore/file-to-not-ignore.md"}))
        .resolves.toBeUndefined()
      await expect(callBefore(hooks, "read", {path: "somedir/toignore/other-file.txt"}))
        .rejects.toThrow(/Access denied/)
    })

    test("allows **/target/** due to negation", async () => {
      await expect(callBefore(hooks, "read", {path: "target/output.jar"})).resolves.toBeUndefined()
      await expect(callBefore(hooks, "read", {path: "target"})).resolves.toBeUndefined()
    })
  })
})

describe("Path Normalization", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  describe("absolute paths", () => {
    test("handles absolute paths correctly", async () => {
      await expect(callBefore(hooks, "read", {path: abs("secrets.json")}))
        .rejects.toThrow(/Access denied/)
    })

    test("allows absolute path to allowed file", async () => {
      await expect(callBefore(hooks, "read", {path: abs("README.md")})).resolves.toBeUndefined()
    })
  })

  describe("./ prefix handling", () => {
    test("handles ./ prefix correctly", async () => {
      await expect(callBefore(hooks, "read", {path: "./secrets.json"}))
        .rejects.toThrow(/Access denied/)
      await expect(callBefore(hooks, "read", {path: "./index.ts"})).resolves.toBeUndefined()
    })
  })

  describe("nested directories", () => {
    test("handles deeply nested paths", async () => {
      await expect(callBefore(hooks, "read", {path: "foo/bar/baz/bamboo-specs/plan.yml"}))
        .rejects.toThrow(/Access denied/)
      await expect(callBefore(hooks, "read", {path: "deep/nested/path/allowed.txt"}))
        .resolves.toBeUndefined()
    })
  })

  describe("directory vs file matching", () => {
    test("directories get trailing slash for matching", async () => {
      // src/ exists as a directory and is allowed
      await expect(callBefore(hooks, "read", {path: "src"})).resolves.toBeUndefined()

      // Files inside bamboo-specs/ should be blocked
      await expect(callBefore(hooks, "read", {path: "bamboo-specs/file.txt"}))
        .rejects.toThrow(/Access denied/)
    })

    test(".local/ directory is allowed", async () => {
      await expect(callBefore(hooks, "read", {path: ".local"})).resolves.toBeUndefined()
      await expect(callBefore(hooks, "grep", {path: ".local"})).resolves.toBeUndefined()
    })
  })
})

describe("Edge Cases", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  test("handles undefined path gracefully", async () => {
    // Tools like glob/grep default to "." when no path provided
    await expect(callBefore(hooks, "glob", {})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "grep", {})).resolves.toBeUndefined()
  })

  test("handles missing path for file tools", async () => {
    // Should not throw, just skip (no path to check)
    await expect(callBefore(hooks, "read", {})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "write", {})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "edit", {})).resolves.toBeUndefined()
  })

  test("handles empty string path", async () => {
    // Empty string should be treated as no path
    await expect(callBefore(hooks, "read", {path: ""})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "glob", {path: ""})).resolves.toBeUndefined()
  })

  test("ignores unsupported tools", async () => {
    // Tool that extractPaths does not handle should be skipped
    await expect(callBefore(hooks, "unknown_tool", {somePath: "secrets.json"})).resolves.toBeUndefined()
  })

  test("handles non-object tool input", async () => {
    await hooks["execute.before"]!({
      tool: "read",
      input: null,
      sessionID: "test-session",
      agent: "build",
      messageID: "test-message",
      id: "test-call",
    })
  })

  test("error message includes blocked path", async () => {
    try {
      await callBefore(hooks, "read", {path: "secrets.json"})
      expect(false).toBe(true) // Should not reach here
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain("secrets.json")
      expect(message).toContain("blocked by ignore file")
      expect(message).toContain("Access denied")
    }
  })
})

describe("Real-world Scenarios", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  test("allows normal development workflow", async () => {
    // Reading source files
    await expect(callBefore(hooks, "read", {path: "index.ts"})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "read", {path: "README.md"})).resolves.toBeUndefined()

    // Writing output
    await expect(callBefore(hooks, "write", {path: "output.txt"})).resolves.toBeUndefined()

    // Searching codebase
    await expect(callBefore(hooks, "grep", {path: "src"})).resolves.toBeUndefined()
    await expect(callBefore(hooks, "glob", {path: "."})).resolves.toBeUndefined()
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
      await expect(callBefore(hooks, "read", {path: file}))
        .rejects.toThrow(/Access denied/)
    }
  })

  test("handles complex project structure", async () => {
    // Should allow src directory
    await expect(callBefore(hooks, "read", {path: "src"})).resolves.toBeUndefined()

    // But block bamboo-specs inside any directory
    await expect(callBefore(hooks, "read", {path: "src/bamboo-specs/plan.yml"}))
      .rejects.toThrow(/Access denied/)
  })
})

describe("Glob Tool Result Filtering", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  test("filters blocked files from glob output", async () => {
    const output = [
      abs("index.ts"),            // ALLOWED
      abs("secrets.json"),        // BLOCKED
      abs("credentials.json"),    // BLOCKED
      abs("README.md"),           // ALLOWED
      abs(".env"),                // BLOCKED
      abs("config.local.json"),   // ALLOWED (negation)
    ].join("\n")

    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, output, {count: 6, truncated: false})

    expect(filtered.output).toBe(
      [abs("index.ts"), abs("README.md"), abs("config.local.json")].join("\n"),
    )
    expect(filtered.metadata?.count).toBe(3)
  })

  test("filters certificate and key files", async () => {
    const output = [abs("server.crt"), abs("private.key"), abs("ca.pem"), abs("README.md")].join("\n")

    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, output, {count: 4, truncated: false})

    expect(filtered.output).toBe(abs("README.md"))
    expect(filtered.metadata?.count).toBe(1)
  })

  test("replaces output with No files found when all files are blocked", async () => {
    const output = [abs("secrets.json"), abs("credentials.json"), abs(".env"), abs("private.key")].join("\n")

    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, output, {count: 4, truncated: false})

    expect(filtered.output).toBe("No files found")
    expect(filtered.metadata?.count).toBe(0)
  })

  test("handles glob output with no files", async () => {
    const filtered = await callAfter(hooks, "glob", {pattern: "**/*.xyz"}, "No files found", {count: 0, truncated: false})

    expect(filtered.output).toBe("No files found")
    expect(filtered.metadata?.count).toBe(0)
  })

  test("handles non-string glob results gracefully", async () => {
    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, undefined)

    expect(filtered.output).toBeUndefined()
    expect(filtered.metadata).toBeUndefined()
  })

  test("respects negation patterns", async () => {
    const output = [
      abs("config.local.json"),     // ALLOWED (negation)
      abs("settings.local.jsonc"),  // ALLOWED (negation)
      abs(".local/impl.md"),        // ALLOWED (negation)
      abs("secrets.json"),          // BLOCKED
    ].join("\n")

    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, output, {count: 4, truncated: false})

    expect(filtered.output).toBe(
      [abs("config.local.json"), abs("settings.local.jsonc"), abs(".local/impl.md")].join("\n"),
    )
    expect(filtered.metadata?.count).toBe(3)
  })

  test("keeps the truncation note when nothing is filtered", async () => {
    const note = "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)"
    const output = [abs("index.ts"), abs("README.md"), "", note].join("\n")

    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, output, {count: 2, truncated: true})

    expect(filtered.output).toBe(output)
    expect(filtered.metadata?.count).toBe(2)
    expect(filtered.metadata?.truncated).toBe(true)
  })

  test("drops the truncation note when files are filtered", async () => {
    const note = "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)"
    const output = [abs("index.ts"), abs("secrets.json"), "", note].join("\n")

    const filtered = await callAfter(hooks, "glob", {pattern: "**/*"}, output, {count: 2, truncated: true})

    expect(filtered.output).toBe(abs("index.ts"))
    expect(filtered.metadata?.count).toBe(1)
    expect(filtered.metadata?.truncated).toBe(false)
  })

  test("does not filter non-glob tools", async () => {
    const output = [abs("secrets.json"), abs("index.ts")].join("\n")

    const filtered = await callAfter(hooks, "read", {}, output)

    // Should return unchanged for non-glob tools
    expect(filtered.output).toBe(output)
  })

  test("ignores failed tool executions", async () => {
    const event: Record<string, unknown> = {
      tool: "glob",
      input: {pattern: "**/*"},
      sessionID: "test-session",
      agent: "build",
      messageID: "test-message",
      id: "test-call",
      status: "error",
      error: {message: "boom"},
    }

    await hooks["execute.after"]!(event)
    expect(event).not.toHaveProperty("result")
  })
})

describe("Grep Tool Result Filtering", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  test("filters blocked files from grep output", async () => {
    const output = [
      "Found 4 matches (more matches available)",
      abs("index.ts") + ":",
      "  Line 10: export",
      "",
      abs("secrets.json") + ":",
      "  Line 3: password",
      "",
      abs("README.md") + ":",
      "  Line 1: # opencode",
      "",
      abs(".env") + ":",
      "  Line 5: API_KEY=secret",
      "",
      "(Results truncated. Consider using a more specific path or pattern.)",
    ].join("\n")

    const filtered = await callAfter(hooks, "grep", {pattern: ".*"}, output, {matches: 4, truncated: true})

    // Summary count is recomputed and the truncation suffix/note are dropped
    expect(filtered.output).toBe(
      [
        "Found 2 matches",
        abs("index.ts") + ":",
        "  Line 10: export",
        "",
        abs("README.md") + ":",
        "  Line 1: # opencode",
      ].join("\n"),
    )
    expect(filtered.metadata?.matches).toBe(2)
    expect(filtered.metadata?.truncated).toBe(false)
  })

  test("does not leak any info about blocked files", async () => {
    const output = [
      "Found 3 matches",
      abs("credentials.json") + ":",
      "  Line 7: admin_password: secret123",
      "",
      abs("private.key") + ":",
      "  Line 1: -----BEGIN PRIVATE KEY-----",
      "",
      abs("index.ts") + ":",
      "  Line 50: const config",
    ].join("\n")

    const filtered = await callAfter(hooks, "grep", {pattern: ".*"}, output, {matches: 3, truncated: false})

    expect(filtered.output).toBe(
      ["Found 1 matches", abs("index.ts") + ":", "  Line 50: const config"].join("\n"),
    )

    // Ensure no info from blocked files leaks
    const resultString = JSON.stringify(filtered)
    expect(resultString).not.toContain("credentials.json")
    expect(resultString).not.toContain("private.key")
    expect(resultString).not.toContain("secret123")
    expect(resultString).not.toContain("PRIVATE KEY")
  })

  test("returns No files found when all matches are blocked", async () => {
    const output = [
      "Found 3 matches",
      abs("secrets.json") + ":",
      "  Line 1: secret",
      "",
      abs(".env") + ":",
      "  Line 2: password",
      "",
      abs("private.key") + ":",
      "  Line 5: key data",
    ].join("\n")

    const filtered = await callAfter(hooks, "grep", {pattern: "secret"}, output, {matches: 3, truncated: false})

    expect(filtered.output).toBe("No files found")
    expect(filtered.metadata?.matches).toBe(0)
  })

  test("handles grep output with no matches", async () => {
    const filtered = await callAfter(hooks, "grep", {pattern: "nonexistent"}, "No files found", {matches: 0, truncated: false})

    expect(filtered.output).toBe("No files found")
    expect(filtered.metadata?.matches).toBe(0)
  })

  test("handles non-string grep results gracefully", async () => {
    const filtered = await callAfter(hooks, "grep", {pattern: "test"}, undefined)

    expect(filtered.output).toBeUndefined()
    expect(filtered.metadata).toBeUndefined()
  })

  test("keeps the truncation suffix when nothing is filtered", async () => {
    const output = [
      "Found 2 matches (more matches available)",
      abs("index.ts") + ":",
      "  Line 10: export",
      "",
      abs("README.md") + ":",
      "  Line 1: # opencode",
      "",
      "(Results truncated. Consider using a more specific path or pattern.)",
    ].join("\n")

    const filtered = await callAfter(hooks, "grep", {pattern: ".*"}, output, {matches: 2, truncated: true})

    expect(filtered.output).toBe(output)
    expect(filtered.metadata?.matches).toBe(2)
  })

  test("respects negation patterns in grep", async () => {
    const output = [
      "Found 3 matches",
      abs("config.local.json") + ":",
      "  Line 1: config",
      "",
      abs(".local/notes.md") + ":",
      "  Line 5: notes",
      "",
      abs("secrets.json") + ":",
      "  Line 2: secret",
    ].join("\n")

    const filtered = await callAfter(hooks, "grep", {pattern: ".*"}, output, {matches: 3, truncated: false})

    expect(filtered.output).toBe(
      [
        "Found 2 matches",
        abs("config.local.json") + ":",
        "  Line 1: config",
        "",
        abs(".local/notes.md") + ":",
        "  Line 5: notes",
      ].join("\n"),
    )
  })

  test("does not filter non-grep tools", async () => {
    const output = [abs("secrets.json") + ":", "  Line 1: secret"].join("\n")

    const filtered = await callAfter(hooks, "write", {}, output)

    // Should return unchanged for non-grep tools
    expect(filtered.output).toBe(output)
  })
})

describe("Structured V2 Result Filtering", () => {
  let hooks: Hooks

  beforeAll(async () => {
    hooks = await createHooks()
  })

  // Helper to call the after hook with a full structured result object
  async function callAfterResult(tool: string, input: Record<string, unknown>, result: Record<string, unknown>) {
    const event: Record<string, unknown> = {
      tool,
      input,
      sessionID: "test-session",
      agent: "build",
      messageID: "test-message",
      id: "test-call",
      status: "completed",
      result,
    }
    await hooks["execute.after"]!(event)
    return event.result as Record<string, unknown>
  }

  test("filters blocked entries from structured glob output", async () => {
    // V2 glob returns entries with paths relative to the location directory
    const output = [
      {path: "index.ts", type: "file"},
      {path: "secrets.json", type: "file"},
      {path: "sub", type: "directory"},
      {path: "credentials.json", type: "file"},
      {path: "README.md", type: "file"},
    ]

    const filtered = await callAfterResult("glob", {pattern: "**/*"}, {output, metadata: {count: 5, truncated: false}})

    expect(filtered.output).toEqual([
      {path: "index.ts", type: "file"},
      {path: "sub", type: "directory"},
      {path: "README.md", type: "file"},
    ])
    expect((filtered.metadata as Record<string, unknown>).count).toBe(3)
    expect((filtered.metadata as Record<string, unknown>).truncated).toBe(false)
  })

  test("filters blocked matches from structured grep output", async () => {
    const output = [
      {entry: {path: "index.ts", type: "file"}, line: 10, offset: 1, text: "export", submatches: []},
      {entry: {path: "secrets.json", type: "file"}, line: 3, offset: 1, text: "password", submatches: []},
      {entry: {path: "README.md", type: "file"}, line: 1, offset: 1, text: "# opencode", submatches: []},
    ]

    const filtered = await callAfterResult("grep", {pattern: ".*"}, {output, metadata: {matches: 3, truncated: true}})

    expect(filtered.output).toEqual([
      {entry: {path: "index.ts", type: "file"}, line: 10, offset: 1, text: "export", submatches: []},
      {entry: {path: "README.md", type: "file"}, line: 1, offset: 1, text: "# opencode", submatches: []},
    ])
    expect((filtered.metadata as Record<string, unknown>).matches).toBe(2)
    expect((filtered.metadata as Record<string, unknown>).truncated).toBe(false)
  })

  test("filters blocked paths from text content blocks", async () => {
    const output = [
      {path: "index.ts", type: "file"},
      {path: "secrets.json", type: "file"},
    ]
    const content = [
      {type: "text", text: `${abs("index.ts")}\n${abs("secrets.json")}`},
    ]

    const filtered = await callAfterResult("glob", {pattern: "**/*"}, {output, content, metadata: {count: 2}})

    expect(filtered.output).toEqual([{path: "index.ts", type: "file"}])
    expect(filtered.content).toEqual([{type: "text", text: abs("index.ts")}])
    expect((filtered.metadata as Record<string, unknown>).count).toBe(1)
  })

  test("filters grep text content and recomputes the summary", async () => {
    const output = [
      {entry: {path: "index.ts", type: "file"}, line: 10, offset: 1, text: "export", submatches: []},
      {entry: {path: ".env", type: "file"}, line: 5, offset: 1, text: "API_KEY=secret", submatches: []},
    ]
    const content = [
      {type: "text", text: ["Found 2 matches", `${abs("index.ts")}:`, "  Line 10: export", "", `${abs(".env")}:`, "  Line 5: API_KEY=secret"].join("\n")},
    ]

    const filtered = await callAfterResult("grep", {pattern: ".*"}, {output, content, metadata: {matches: 2}})

    expect(filtered.output).toEqual([
      {entry: {path: "index.ts", type: "file"}, line: 10, offset: 1, text: "export", submatches: []},
    ])
    expect((filtered.content as {text: string}[])[0]!.text).toBe(
      ["Found 1 matches", `${abs("index.ts")}:`, "  Line 10: export"].join("\n"),
    )
    expect((filtered.metadata as Record<string, unknown>).matches).toBe(1)
  })

  test("drops stale text content when it still lists blocked paths", async () => {
    // Output filtered but content not parseable/filterable by the text
    // filter - drop the text entirely rather than risk a leak
    const output = [
      {entry: {path: "index.ts", type: "file"}, line: 1, offset: 1, text: "export", submatches: []},
      {entry: {path: "secrets.json", type: "file"}, line: 3, offset: 1, text: "password", submatches: []},
    ]
    const content = [{type: "text", text: "excerpt without a summary line"}]

    const filtered = await callAfterResult("grep", {pattern: ".*"}, {output, content, metadata: {matches: 2}})

    expect(filtered.output).toEqual([
      {entry: {path: "index.ts", type: "file"}, line: 1, offset: 1, text: "export", submatches: []},
    ])
    expect(filtered.content).toBeUndefined()
    expect((filtered.metadata as Record<string, unknown>).matches).toBe(1)
  })

  test("leaves the result untouched when nothing is blocked", async () => {
    const output = [
      {path: "index.ts", type: "file"},
      {path: "README.md", type: "file"},
    ]
    const content = [{type: "text", text: `${abs("index.ts")}\n${abs("README.md")}`}]
    const metadata = {count: 2, truncated: true}

    const filtered = await callAfterResult("glob", {pattern: "**/*"}, {output, content, metadata})

    // Same references - no rewriting when nothing is filtered
    expect(filtered.output).toBe(output)
    expect(filtered.content).toBe(content)
    expect(filtered.metadata).toBe(metadata)
  })

  test("keeps structured entries without a recognizable path", async () => {
    const output = [{path: "secrets.json", type: "file"}, {note: "no path here"}]

    const filtered = await callAfterResult("glob", {pattern: "**/*"}, {output, metadata: {count: 2}})

    expect(filtered.output).toEqual([{note: "no path here"}])
    expect((filtered.metadata as Record<string, unknown>).count).toBe(1)
  })

  test("does not filter structured results for non-search tools", async () => {
    const output = [{path: "secrets.json", type: "file"}]

    const filtered = await callAfterResult("read", {path: "secrets.json"}, {output})

    expect(filtered.output).toBe(output)
    expect(filtered.metadata).toBeUndefined()
  })
})

describe("Distribution", () => {
  test("committed dist/ is in sync with index.ts", async () => {
    const root = process.cwd()
    const outdir = await mkdtemp(path.join(os.tmpdir(), "opencode-ignore-build-"))

    try {
      // Same flags as the package.json build script; process.execPath works
      // whether tests run via npx bun or a locally installed bun
      const proc = Bun.spawnSync(
        [process.execPath, "build", "./index.ts", "--outdir", outdir, "--target", "node", "--external=@opencode/plugin"],
        {cwd: root},
      )
      expect(proc.exitCode).toBe(0)

      const built = await Bun.file(path.join(outdir, "index.js")).text()
      const committedFile = Bun.file(path.join(root, "dist", "index.js"))
      expect(await committedFile.exists()).toBe(true)

      const committed = await committedFile.text()
      if (committed !== built) {
        throw new Error(
          "dist/index.js is stale - run: npx --yes bun@1.3.1 run bundle (then commit dist/)",
        )
      }
    } finally {
      await rm(outdir, {recursive: true, force: true})
    }
  })
})
