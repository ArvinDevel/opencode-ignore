import {Plugin} from "@opencode/plugin"
import ignore from "ignore"
import {isPathValid} from "ignore"
import {join, isAbsolute, relative, dirname} from "path"
import {stat, readFile} from "node:fs/promises"

type IgnoreLib = ReturnType<typeof ignore>

interface IgnoreSource {
  lib: IgnoreLib
  /** Directory that contains the .ignore file; patterns are relative to it */
  root: string
}

interface PathInfo {
  path: string
  isDirectory: boolean
}

interface FilteredOutput {
  output: string
  count: number
  filtered: boolean
}

/**
 * Find the nearest .ignore file, searching upward from the location directory
 * (the directory OpenCode tools resolve relative paths against).
 *
 * Searching upward keeps protection working when OpenCode is started in a
 * subdirectory of the project, mirroring how git discovers .gitignore files.
 * The search stops at the canonical project root when it is an ancestor,
 * otherwise at the filesystem root.
 *
 * @param directory - Directory to start searching from
 * @param stopAt - Never search above this directory when it is an ancestor
 * @returns Ignore source with the pattern root, or null if no .ignore exists
 */
async function findIgnore(directory: string, stopAt: string): Promise<IgnoreSource | null> {
  // node:fs/promises instead of Bun.file so this also runs where the Bun
  // global is unavailable (for example the OpenCode desktop app).
  const source = await readFile(join(directory, ".ignore"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR") return null
    throw error
  })
  if (source !== null) {
    const lib = ignore()
    lib.add(source)
    return {lib, root: directory}
  }

  if (directory === stopAt) return null
  const parent = dirname(directory)
  if (parent === directory) return null
  return findIgnore(parent, stopAt)
}

/**
 * Convert a path to an absolute path (relative paths resolve against the
 * directory OpenCode tools use as their base).
 */
function toAbsolute(targetPath: string, resolveDir: string): string {
  return isAbsolute(targetPath) ? targetPath : join(resolveDir, targetPath)
}

/**
 * Check whether an existing path is a directory.
 * Returns undefined when the path does not exist.
 */
async function pathIsDirectory(absolutePath: string): Promise<boolean | undefined> {
  const info = await stat(absolutePath).catch(() => undefined)
  if (!info) return undefined
  return info.isDirectory()
}

/**
 * Normalize path to format required by ignore library
 *
 * The ignore library requires specific path format:
 * - Must be relative to the .ignore file location (no absolute paths)
 * - No "./" prefix (must be clean like "src/file.ts")
 * - Use forward slashes (Win32 backslashes converted)
 * - Directories need trailing "/" for proper matching
 *
 * @param targetPath - Path to normalize (absolute or relative)
 * @param resolveDir - Directory relative tool paths resolve against
 * @param ignoreRoot - Directory containing the .ignore file
 * @param isDirectory - Whether the path represents a directory
 * @returns Normalized relative path, or "." for the .ignore root itself
 * @throws Error if resulting path format is invalid (fails closed)
 */
function normalizePath(targetPath: string, resolveDir: string, ignoreRoot: string, isDirectory: boolean): string {
  // Step 1: Convert to absolute if needed (handles relative paths)
  const absolutePath = toAbsolute(targetPath, resolveDir)

  // Step 2: Make relative to the .ignore file location
  const relativePath = relative(ignoreRoot, absolutePath)

  // Step 3: Handle empty path (the .ignore root itself - always allowed)
  if (relativePath === "") return "."

  // Step 4: Normalize separators (Win32 backslashes → forward slashes)
  const normalizedPath = relativePath.replace(/\\/g, "/")

  // Step 5: Remove "./" prefix (critical - ignore library requirement)
  const withoutPrefixPath = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath

  // Step 6: Add trailing "/" for directories
  // This ensures directory patterns match correctly (e.g., "src/" vs "src")
  const withSlashPath = isDirectory && !withoutPrefixPath.endsWith("/")
    ? withoutPrefixPath + "/"
    : withoutPrefixPath

  // Step 7: Validate path format using ignore library validator
  if (!isPathValid(withSlashPath)) {
    throw new Error(`Invalid path format: ${withSlashPath}`)
  }

  return withSlashPath
}

/**
 * Check whether a path matches ignore patterns.
 * Fails closed: paths that cannot be normalized are treated as blocked.
 */
function isBlocked(targetPath: string, source: IgnoreSource, resolveDir: string, isDirectory: boolean): boolean {
  try {
    const normalized = normalizePath(targetPath, resolveDir, source.root, isDirectory)
    if (normalized === ".") return false
    return source.lib.ignores(normalized)
  } catch {
    // Paths that cannot be normalized are filtered out (fail closed)
    return true
  }
}

/**
 * File headers used by the patch tool input (`patchText`).
 */
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/gm

/**
 * Extract every file path touched by a patch tool input.
 *
 * @param patchText - Raw patch text (*** Begin Patch ... *** End Patch)
 * @returns Paths referenced by add/update/delete/move directives
 */
function extractPatchPaths(patchText: string): string[] {
  const paths: string[] = []
  for (const match of patchText.matchAll(PATCH_FILE_HEADER)) {
    if (match[1]) paths.push(match[1].trim())
  }
  for (const match of patchText.matchAll(PATCH_MOVE_HEADER)) {
    if (match[1]) paths.push(match[1].trim())
  }
  return paths
}

/**
 * Extract path and type from V2 tool arguments
 *
 * Maps OpenCode V2 native tools to their path arguments and determines
 * if they operate on files or directories. This is critical for
 * proper ignore pattern matching (directories need trailing slash).
 *
 * Supported tools:
 * - File operations: read, write, edit (args.path)
 * - Patch operation: patch (paths parsed from args.patchText)
 * - Search operations: glob, grep (args.path, defaults to ".")
 * - Directory listing: read with a directory path
 *
 * @param tool - Tool name
 * @param args - Tool input object
 * @param resolveDir - Directory relative paths resolve against
 * @returns PathInfo entries to check, empty when the tool has no path
 */
async function extractPaths(tool: string, args: Record<string, unknown>, resolveDir: string): Promise<PathInfo[]> {
  // Read operates on files and (in V2) directories - stat decides the form
  if (tool === "read") {
    const target = args.path
    if (typeof target !== "string" || target === "") return []
    const isDirectory = (await pathIsDirectory(toAbsolute(target, resolveDir))) ?? false
    return [{path: target, isDirectory}]
  }

  // Write and edit always target files
  if (tool === "write" || tool === "edit") {
    const target = args.path
    if (typeof target !== "string" || target === "") return []
    return [{path: target, isDirectory: false}]
  }

  // Search operations - path defaults to "." (project root)
  if (tool === "glob" || tool === "grep") {
    const target = typeof args.path === "string" && args.path !== "" ? args.path : "."
    const isDirectory = (await pathIsDirectory(toAbsolute(target, resolveDir))) ?? true
    return [{path: target, isDirectory}]
  }

  // Patch can touch several files in one call
  if (tool === "patch") {
    const patchText = args.patchText
    if (typeof patchText !== "string") return []
    return extractPatchPaths(patchText).map((target) => ({path: target, isDirectory: false}))
  }

  // Unknown tool - no path checking needed
  return []
}

/**
 * Filter glob tool output to remove blocked files
 *
 * V2 glob returns a newline-joined string of absolute file paths,
 * an optional "(Results are truncated...)" note, or "No files found".
 *
 * @param output - Original glob output text
 * @param source - Loaded ignore source
 * @param resolveDir - Directory relative paths resolve against
 * @returns Filtered output with blocked files removed
 */
function filterGlobOutput(output: string, source: IgnoreSource, resolveDir: string): FilteredOutput {
  const kept: string[] = []
  let total = 0

  for (const line of output.split("\n")) {
    if (line === "" || line === "No files found") continue
    if (line.startsWith("(")) continue // truncation notes carry no file data
    total += 1
    if (!isBlocked(line, source, resolveDir, false)) kept.push(line)
  }

  // Nothing to filter - return the original output untouched
  if (total === 0 || kept.length === total) return {output, count: kept.length, filtered: false}

  // Everything was blocked - leak nothing
  if (kept.length === 0) return {output: "No files found", count: 0, filtered: true}

  // Drop truncation notes when filtering happened (they reveal blocked counts)
  return {output: kept.join("\n"), count: kept.length, filtered: true}
}

/**
 * Filter grep tool output to remove matches from blocked files
 *
 * V2 grep returns a newline-joined string:
 *
 *   Found 4 matches (more matches available)?
 *   /abs/path/file.ts:
 *     Line 10: match text
 *
 *   /abs/other.ts:
 *     Line 3: match text
 *   (Results truncated...)
 *
 * @param output - Original grep output text
 * @param source - Loaded ignore source
 * @param resolveDir - Directory relative paths resolve against
 * @returns Filtered output with matches from blocked files removed
 */
function filterGrepOutput(output: string, source: IgnoreSource, resolveDir: string): FilteredOutput {
  const lines = output.split("\n")
  const summary = /^Found (\d+) matches( \(more matches available\))?$/.exec(lines[0] ?? "")
  if (!summary) return {output, count: 0, filtered: false}

  const originalTotal = Number(summary[1])
  const blocks: {path: string; lines: string[]}[] = []
  let current: {path: string; lines: string[]} | undefined

  for (const line of lines.slice(1)) {
    if (line === "") continue
    if (line.startsWith("(")) {
      current = undefined
      continue // truncation notes carry no match data
    }
    if (!line.startsWith("  ") && line.endsWith(":")) {
      current = {path: line.slice(0, -1), lines: []}
      blocks.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }

  const keptBlocks = blocks.filter((block) => !isBlocked(block.path, source, resolveDir, false))
  const count = keptBlocks.reduce((total, block) => total + block.lines.length, 0)

  // Nothing to filter - return the original output untouched
  if (count === originalTotal) return {output, count, filtered: false}

  // Everything was blocked - leak nothing
  if (count === 0) return {output: "No files found", count: 0, filtered: true}

  // Rebuild output; drop "(more matches available)" when filtering happened
  const rebuilt: string[] = [`Found ${count} matches`]
  for (const [index, block] of keptBlocks.entries()) {
    if (index > 0) rebuilt.push("")
    rebuilt.push(`${block.path}:`)
    rebuilt.push(...block.lines)
  }
  return {output: rebuilt.join("\n"), count, filtered: true}
}

interface FilteredValue {
  value: unknown
  count: number
  filtered: boolean
}

/**
 * Extract the path of a structured tool result entry, if recognizable.
 * Glob entries carry `path` directly; grep entries nest it under `entry.path`.
 * Entries without a recognizable path are kept (nothing to match against).
 */
function entryPath(entry: unknown, tool: string): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined
  if (tool === "glob") {
    const path = (entry as {path?: unknown}).path
    return typeof path === "string" ? path : undefined
  }
  const inner = (entry as {entry?: unknown}).entry
  if (inner === null || typeof inner !== "object") return undefined
  const path = (inner as {path?: unknown}).path
  return typeof path === "string" ? path : undefined
}

/**
 * Filter a tool result value: newline-joined text (old shape) or the
 * structured entry array V2 glob/grep actually return.
 * Returns the original value untouched when nothing is blocked.
 */
function filterResultValue(
  tool: string,
  value: unknown,
  source: IgnoreSource,
  resolveDir: string,
): FilteredValue {
  if (typeof value === "string") {
    const filtered = tool === "glob"
      ? filterGlobOutput(value, source, resolveDir)
      : filterGrepOutput(value, source, resolveDir)
    return {value: filtered.output, count: filtered.count, filtered: filtered.filtered}
  }
  if (!Array.isArray(value)) return {value, count: 0, filtered: false}

  const kept = value.filter((entry) => {
    const path = entryPath(entry, tool)
    if (path === undefined) return true
    const isDirectory = tool === "glob" && (entry as {type?: unknown}).type === "directory"
    return !isBlocked(path, source, resolveDir, isDirectory)
  })
  if (kept.length === value.length) return {value, count: value.length, filtered: false}
  return {value: kept, count: kept.length, filtered: true}
}

/**
 * Filter the text `content` of a tool result: a plain string or an array of
 * content blocks whose text items repeat the file paths. Returns the original
 * value untouched when nothing is blocked.
 */
function filterResultContent(
  tool: string,
  content: unknown,
  source: IgnoreSource,
  resolveDir: string,
): FilteredValue {
  if (typeof content === "string") {
    const filtered = tool === "glob"
      ? filterGlobOutput(content, source, resolveDir)
      : filterGrepOutput(content, source, resolveDir)
    return {value: filtered.output, count: filtered.count, filtered: filtered.filtered}
  }
  if (!Array.isArray(content)) return {value: content, count: 0, filtered: false}

  let count = 0
  let anyFiltered = false
  const kept = content.map((item) => {
    if (item === null || typeof item !== "object") return item
    const block = item as {type?: unknown; text?: unknown}
    if (block.type !== "text" || typeof block.text !== "string") return item
    const filtered = tool === "glob"
      ? filterGlobOutput(block.text, source, resolveDir)
      : filterGrepOutput(block.text, source, resolveDir)
    if (!filtered.filtered) return item
    anyFiltered = true
    count += filtered.count
    return {...block, text: filtered.output}
  })
  return {value: anyFiltered ? kept : content, count, filtered: anyFiltered}
}

/**
 * OpenCode V2 plugin to restrict AI access using .ignore patterns
 *
 * Intercepts native OpenCode V2 tools (read, write, edit, patch, glob, grep)
 * and blocks access to paths matching patterns in .ignore file.
 *
 * Features:
 * - Gitignore-style patterns via ignore library
 * - .ignore discovered upward from the OpenCode location directory
 * - Graceful degradation if .ignore missing
 * - The .ignore root itself is always accessible
 *
 * @example
 * // .ignore file
 * /secrets/**
 * *.key
 * !config.local.json
 */
export default Plugin.define({
  id: "opencode-ignore",
  async setup(ctx) {
    // Directory OpenCode tools resolve relative paths against
    const resolveDir = ctx.location.directory
    // Never search for .ignore above the canonical project root
    const stopAt = ctx.location.project.canonical

    /**
     * Hook that runs before any tool execution
     * Checks whether the tool's target paths are blocked by .ignore patterns
     */
    await ctx.tool.hook("execute.before", async (event) => {
      const source = await findIgnore(resolveDir, stopAt)
      if (!source) return // No .ignore file = allow all access

      const input = event.input
      if (!input || typeof input !== "object") return

      const paths = await extractPaths(event.tool, input as Record<string, unknown>, resolveDir)
      for (const info of paths) {
        const normalized = normalizePath(info.path, resolveDir, source.root, info.isDirectory)
        if (normalized === ".") continue // The .ignore root itself is always allowed
        if (source.lib.ignores(normalized)) {
          throw new Error(`Access denied: ${info.path} blocked by ignore file. Do NOT try to read this. Access restricted.`)
        }
      }
    })

    /**
     * Hook that runs after tool execution
     * Filters glob/grep results to remove blocked files and matches
     */
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      if (event.tool !== "glob" && event.tool !== "grep") return

      const source = await findIgnore(resolveDir, stopAt)
      if (!source) return

      const result = event.result
      const output = filterResultValue(event.tool, result.output, source, resolveDir)
      const content = filterResultContent(event.tool, result.content, source, resolveDir)
      if (!output.filtered && !content.filtered) return

      const filtered = output.filtered ? output : content
      const metadata: Record<string, unknown> = {...(result.metadata ?? {}), truncated: false}
      if (event.tool === "glob") metadata.count = filtered.count
      else metadata.matches = filtered.count

      const next: Record<string, unknown> = {...result, metadata}
      if (output.filtered) next.output = output.value
      if (content.filtered) next.content = content.value

      // If structured output lost entries but text content did not (or vice
      // versa), the unfiltered side may still list blocked paths - drop it
      // rather than leak.
      if (output.filtered && result.content !== undefined && !content.filtered) delete next.content
      if (content.filtered && result.output !== undefined && !output.filtered) delete next.output

      event.result = next as typeof event.result
    })
  },
})
