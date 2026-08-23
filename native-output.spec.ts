import {beforeAll, describe, expect, test} from "bun:test"
import path from "path"
import {tmpdir} from "node:os"
import type {OpenCodeToolOutput, ToolAfterHook} from "./test-support"
import {TEST_PROJECT_ROOT, callAfterHook, createPlugin} from "./test-support"

describe("Glob Tool Result Filtering", () => {
  let afterHook: ToolAfterHook

  beforeAll(async () => {
    afterHook = (await createPlugin())["tool.execute.after"]
  })

  test("filters native glob output safely and fails closed for malformed glob output", async () => {
    const indexPath = path.join(TEST_PROJECT_ROOT, "index.ts")
    const secretPath = path.join(TEST_PROJECT_ROOT, "secrets.json")
    const localPath = path.join(TEST_PROJECT_ROOT, "config.local.json")
    const localDirectoryPath = path.join(TEST_PROJECT_ROOT, ".local", "impl.md")
    const footer = "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)"
    const fixtures = [
      {
        title: "mixed glob",
        source: [indexPath, secretPath, localPath].join("\n"),
        metadata: {count: 3, truncated: false, outputPath: "/tmp/unfiltered-glob", trace: "keep"},
        expectedOutput: [indexPath, localPath].join("\n"),
        expectedMetadata: {count: 2, truncated: false, trace: "keep"},
        hidden: [secretPath, "unfiltered-glob"],
      },
      {
        title: "all blocked glob",
        source: [secretPath, path.join(TEST_PROJECT_ROOT, "credentials.json")].join("\n"),
        metadata: {count: 2, truncated: false, outputPath: "/tmp/all-blocked-glob", trace: "keep"},
        expectedOutput: "No files found",
        expectedMetadata: {count: 0, truncated: false, trace: "keep"},
        hidden: [secretPath, "all-blocked-glob"],
      },
      {
        title: "empty glob",
        source: "No files found",
        metadata: {count: 0, truncated: false, outputPath: "/tmp/empty-glob", trace: "keep"},
        expectedOutput: "No files found",
        expectedMetadata: {count: 0, truncated: false, trace: "keep"},
        hidden: ["empty-glob"],
      },
      {
        title: "truncated glob",
        source: [indexPath, secretPath, "", footer].join("\n"),
        metadata: {count: 2, truncated: false, outputPath: "/tmp/truncated-glob", trace: "keep"},
        expectedOutput: [indexPath, "", footer].join("\n"),
        expectedMetadata: {count: 1, truncated: true, trace: "keep"},
        hidden: [secretPath, "truncated-glob"],
      },
      {
        title: "negated glob",
        source: [localPath, localDirectoryPath, secretPath].join("\n"),
        metadata: {count: 3, truncated: false},
        expectedOutput: [localPath, localDirectoryPath].join("\n"),
        expectedMetadata: {count: 2, truncated: false},
        hidden: [secretPath],
      },
      {
        title: "malformed count mismatch glob",
        source: "secret-token-value",
        metadata: {count: 2, truncated: false, outputPath: "/tmp/mismatched-glob", trace: "keep"},
        expectedOutput: "No files found",
        expectedMetadata: {count: 0, truncated: false, trace: "keep"},
        hidden: ["secret-token-value", "mismatched-glob"],
      },
      {
        title: "outside glob",
        source: [indexPath, path.join(tmpdir(), "outside-glob.txt")].join("\n"),
        metadata: {count: 2, truncated: false},
        expectedOutput: indexPath,
        expectedMetadata: {count: 1, truncated: false},
        hidden: ["outside-glob.txt"],
      },
    ]

    for (const fixture of fixtures) {
      const output: OpenCodeToolOutput = {title: fixture.title, output: fixture.source, metadata: {...fixture.metadata}}

      expect(await callAfterHook(afterHook, "glob", {pattern: "**/*"}, output)).toBeUndefined()
      expect(output).toEqual({title: fixture.title, output: fixture.expectedOutput, metadata: fixture.expectedMetadata})
      for (const hidden of fixture.hidden) expect(JSON.stringify(output)).not.toContain(hidden)
    }
  })

})
describe("Grep Tool Result Filtering", () => {
  let afterHook: ToolAfterHook

  beforeAll(async () => {
    afterHook = (await createPlugin())["tool.execute.after"]
  })

  test("filters native grep output safely and does not leak blocked or malformed grep content", async () => {
    const indexPath = path.join(TEST_PROJECT_ROOT, "index.ts")
    const secretPath = path.join(TEST_PROJECT_ROOT, "secrets.json")
    const readmePath = path.join(TEST_PROJECT_ROOT, "README.md")
    const credentialPath = path.join(TEST_PROJECT_ROOT, "credentials.json")
    const localPath = path.join(TEST_PROJECT_ROOT, "config.local.json")
    const localDirectoryPath = path.join(TEST_PROJECT_ROOT, ".local", "notes.md")
    const footer = "(Results truncated. Consider using a more specific path or pattern.)"
    const fixtures = [
      {
        title: "mixed grep",
        source: [
          "Found 4 matches", `${indexPath}:`, "  Line 1: export const plugin", "  Line 9: const configuration", "",
          `${credentialPath}:`, "  Line 7: admin_password: secret123", "", `${readmePath}:`, "  Line 1: # README",
        ].join("\n"),
        metadata: {matches: 4, truncated: false, outputPath: "/tmp/unfiltered-grep", trace: "keep"},
        expectedOutput: [
          "Found 3 matches", `${indexPath}:`, "  Line 1: export const plugin", "  Line 9: const configuration", "",
          `${readmePath}:`, "  Line 1: # README",
        ].join("\n"),
        expectedMetadata: {matches: 3, truncated: false, trace: "keep"},
        hidden: [credentialPath, "credentials.json", "admin_password: secret123", "unfiltered-grep"],
      },
      {
        title: "empty grep",
        source: "No files found",
        metadata: {matches: 0, truncated: false, outputPath: "/tmp/empty-grep", trace: "keep"},
        expectedOutput: "No files found",
        expectedMetadata: {matches: 0, truncated: false, trace: "keep"},
        hidden: ["empty-grep"],
      },
      {
        title: "truncated grep",
        source: [
          "Found 2 matches (more matches available)", `${indexPath}:`, "  Line 1: allowed", "",
          `${secretPath}:`, "  Line 2: blocked", "", footer,
        ].join("\n"),
        metadata: {matches: 2, truncated: false, outputPath: "/tmp/truncated-grep", trace: "keep"},
        expectedOutput: ["Found 1 matches (more matches available)", `${indexPath}:`, "  Line 1: allowed", "", footer].join("\n"),
        expectedMetadata: {matches: 1, truncated: true, trace: "keep"},
        hidden: [secretPath, "truncated-grep"],
      },
      {
        title: "truncated all blocked grep",
        source: ["Found 1 matches (more matches available)", `${secretPath}:`, "  Line 1: blocked", "", footer].join("\n"),
        metadata: {matches: 1, truncated: false},
        expectedOutput: "No files found",
        expectedMetadata: {matches: 0, truncated: true},
        hidden: [secretPath],
      },
      {
        title: "negated grep",
        source: [
          "Found 3 matches", `${localPath}:`, "  Line 1: config", "", `${localDirectoryPath}:`, "  Line 5: notes", "",
          `${secretPath}:`, "  Line 2: secret",
        ].join("\n"),
        metadata: {matches: 3, truncated: false},
        expectedOutput: [
          "Found 2 matches", `${localPath}:`, "  Line 1: config", "", `${localDirectoryPath}:`, "  Line 5: notes",
        ].join("\n"),
        expectedMetadata: {matches: 2, truncated: false},
        hidden: [secretPath],
      },
      {
        title: "malformed header",
        source: ["Found matches", `${indexPath}:`, "  Line 1: allowed"].join("\n"),
        metadata: {matches: 1, truncated: false, outputPath: "/tmp/malformed-header"},
        expectedOutput: "No files found",
        expectedMetadata: {matches: 0, truncated: false},
        hidden: ["malformed-header"],
      },
      {
        title: "malformed group count mismatch",
        source: ["Found 2 matches", `${indexPath}:`, "secret-unclassified-content"].join("\n"),
        metadata: {matches: 2, truncated: false, outputPath: "/tmp/malformed-grep"},
        expectedOutput: "No files found",
        expectedMetadata: {matches: 0, truncated: false},
        hidden: ["secret-unclassified-content", "malformed-grep"],
      },
      {
        title: "outside grep",
        source: ["Found 1 matches", `${path.join(tmpdir(), "outside-grep.txt")}:`, "  Line 1: outside"].join("\n"),
        metadata: {matches: 1, truncated: false, outputPath: "/tmp/outside-grep"},
        expectedOutput: "No files found",
        expectedMetadata: {matches: 0, truncated: false},
        hidden: ["outside-grep.txt", "outside-grep"],
      },
      {
        title: "metadata mismatch",
        source: ["Found 1 matches", `${indexPath}:`, "  Line 1: allowed"].join("\n"),
        metadata: {matches: 2, truncated: false, outputPath: "/tmp/mismatched-metadata"},
        expectedOutput: "No files found",
        expectedMetadata: {matches: 0, truncated: false},
        hidden: ["mismatched-metadata"],
      },
    ]

    for (const fixture of fixtures) {
      const output: OpenCodeToolOutput = {title: fixture.title, output: fixture.source, metadata: {...fixture.metadata}}

      expect(await callAfterHook(afterHook, "grep", {pattern: ".*"}, output)).toBeUndefined()
      expect(output).toEqual({title: fixture.title, output: fixture.expectedOutput, metadata: fixture.expectedMetadata})
      for (const hidden of fixture.hidden) expect(JSON.stringify(output)).not.toContain(hidden)
    }
  })

  test("filters v1.3.4 non-truncated grep output with an inaccessible-path notice", async () => {
    const allowedPath = path.join(TEST_PROJECT_ROOT, "index.ts")
    const blockedPath = path.join(TEST_PROJECT_ROOT, "secrets.json")
    const inaccessibleNotice = "(Some paths were inaccessible and skipped)"
    const output: OpenCodeToolOutput = {
      title: "v1.3.4 non-truncated grep notice",
      output: [
        "Found 3 matches",
        `${allowedPath}:`,
        "  Line 1: allowed-one",
        "  Line 2: allowed-two",
        "",
        `${blockedPath}:`,
        "  Line 3: blocked-secret",
        "",
        inaccessibleNotice,
      ].join("\n"),
      metadata: {matches: 3, truncated: false, outputPath: "/tmp/unfiltered-v134-notice", trace: "keep"},
    }

    expect(await callAfterHook(afterHook, "grep", {pattern: ".*"}, output)).toBeUndefined()
    expect(output).toEqual({
      title: "v1.3.4 non-truncated grep notice",
      output: [
        "Found 2 matches",
        `${allowedPath}:`,
        "  Line 1: allowed-one",
        "  Line 2: allowed-two",
        "",
        inaccessibleNotice,
      ].join("\n"),
      metadata: {matches: 2, truncated: false, trace: "keep"},
    })
    for (const hidden of [blockedPath, "blocked-secret", "unfiltered-v134-notice"]) {
      expect(JSON.stringify(output)).not.toContain(hidden)
    }
  })

  test("fails closed for a v1.3.4 notice separated by one newline", async () => {
    const allowedPath = path.join(TEST_PROJECT_ROOT, "index.ts")
    const blockedPath = path.join(TEST_PROJECT_ROOT, "secrets.json")
    const shown = 100
    const total = 120
    const allowedRows = Array.from({length: shown / 2}, (_, index) => `  Line ${index + 1}: allowed-${index + 1}`)
    const blockedRows = Array.from({length: shown / 2}, (_, index) => `  Line ${index + allowedRows.length + 1}: blocked-secret-${index + allowedRows.length + 1}`)
    const inaccessibleNotice = "(Some paths were inaccessible and skipped)"
    const legacyFooter = `(Results truncated: showing ${shown} of ${total} matches (${total - shown} hidden). Consider using a more specific path or pattern.)`
    const output: OpenCodeToolOutput = {
      title: "v1.3.4 malformed one-newline notice",
      output: [
        `Found ${total} matches (showing first ${shown})`,
        `${allowedPath}:`,
        ...allowedRows,
        "",
        `${blockedPath}:`,
        ...blockedRows,
        "",
        legacyFooter,
        inaccessibleNotice,
      ].join("\n"),
      metadata: {matches: total, truncated: false, outputPath: "/tmp/malformed-one-newline-notice", trace: "keep"},
    }

    expect(await callAfterHook(afterHook, "grep", {pattern: ".*"}, output)).toBeUndefined()
    expect(output).toEqual({
      title: "v1.3.4 malformed one-newline notice",
      output: "No files found",
      metadata: {matches: 0, truncated: true, trace: "keep"},
    })
    for (const hidden of [allowedPath, blockedPath, "allowed-", "blocked-secret-", inaccessibleNotice, "malformed-one-newline-notice"]) {
      expect(JSON.stringify(output)).not.toContain(hidden)
    }
  })

  test("filters v1.3.4 truncated grep output safely", async () => {
    const allowedPath = path.join(TEST_PROJECT_ROOT, "index.ts")
    const blockedPath = path.join(TEST_PROJECT_ROOT, "secrets.json")
    const shown = 100
    const total = 120
    const allowedRows = Array.from({length: shown / 2}, (_, index) => `  Line ${index + 1}: allowed-${index + 1}`)
    const blockedRows = Array.from({length: shown / 2}, (_, index) => `  Line ${index + allowedRows.length + 1}: blocked-secret-${index + allowedRows.length + 1}`)
    const inaccessibleNotice = "(Some paths were inaccessible and skipped)"
    const legacyFooter = `(Results truncated: showing ${shown} of ${total} matches (${total - shown} hidden). Consider using a more specific path or pattern.)`
    const output: OpenCodeToolOutput = {
      title: "v1.3.4 truncated grep",
      output: [
        `Found ${total} matches (showing first ${shown})`,
        `${allowedPath}:`,
        ...allowedRows,
        "",
        `${blockedPath}:`,
        ...blockedRows,
        "",
        legacyFooter,
        "",
        inaccessibleNotice,
      ].join("\n"),
      metadata: {matches: total, truncated: false, outputPath: "/tmp/unfiltered-v134-grep", trace: "keep"},
    }

    expect(await callAfterHook(afterHook, "grep", {pattern: ".*"}, output)).toBeUndefined()
    expect(output).toEqual({
      title: "v1.3.4 truncated grep",
      output: [
        `Found ${allowedRows.length} matches (more matches available)`,
        `${allowedPath}:`,
        ...allowedRows,
        "",
        "(Results truncated. Consider using a more specific path or pattern.)",
        "",
        inaccessibleNotice,
      ].join("\n"),
      metadata: {matches: allowedRows.length, truncated: true, trace: "keep"},
    })
    for (const hidden of [blockedPath, "blocked-secret-", "unfiltered-v134-grep"]) {
      expect(JSON.stringify(output)).not.toContain(hidden)
    }
  })

})
