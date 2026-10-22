import { Plugin } from "@opencode/plugin"
import ignore from "ignore"
import { isPathValid } from "ignore"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

type Ignore = ReturnType<typeof ignore>

/**
 * Where the ignore rules live and how tool paths are resolved.
 *
 * `projectRoot` is the root of the current checkout, so `.ignore` is read from
 * there. `baseDirectory` matches OpenCode's active location: relative tool
 * paths (and relative glob/grep results) are resolved against it.
 */
interface ProjectContext {
  readonly projectRoot: string
  readonly baseDirectory: string
}

interface PathInfo {
  readonly path: string
  readonly kind: "file" | "directory" | "any"
}

interface GlobEntry {
  readonly path: string
  readonly type: "file" | "directory"
}

interface GrepMatch {
  readonly entry: GlobEntry
  readonly line: number
  readonly text: string
}

type Content = { readonly type: "text"; readonly text: string } | {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

export interface ToolResult {
  readonly output?: unknown
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * Load ignore patterns from project root using the .ignore file.
 *
 * Uses `node:fs/promises` rather than `Bun.file` so the plugin also works in
 * runtimes without the Bun global (for example the OpenCode desktop app).
 *
 * @param projectRoot - Absolute path to project root
 * @returns Ignore instance or null if no ignore file exists
 */
async function loadIgnore(projectRoot: string): Promise<Ignore | null> {
  const source = await readFile(join(projectRoot, ".ignore"), "utf8").catch((error: NodeJS.ErrnoException) => {
    // Missing .ignore means graceful degradation, not a plugin failure.
    if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR") return null
    throw error
  })

  if (source === null) return null

  return ignore().add(source)
}

/**
 * Normalize path to format required by ignore library
 *
 * The ignore library requires specific path format:
 * - Must be relative to project root (no absolute paths)
 * - No "./" prefix (must be clean like "src/file.ts")
 * - Use forward slashes (Win32 backslashes converted)
 * - Directories need trailing "/" for proper matching
 *
 * @param targetPath - Path to normalize (absolute or relative)
 * @param context - Project root and directory used to resolve relative paths
 * @param isDirectory - Whether the path represents a directory
 * @returns Normalized relative path ready for ignore library
 * @throws Error if resulting path format is invalid
 */
function normalizePath(targetPath: string, context: ProjectContext, isDirectory: boolean): string {
  // Step 1: Convert to absolute if needed (relative paths are relative to the active location)
  const absolutePath = isAbsolute(targetPath) ? targetPath : resolve(context.baseDirectory, targetPath)

  // Step 2: Make relative to project root
  const relativePath = relative(context.projectRoot, absolutePath)

  // Step 3: Handle empty path (project root itself)
  const resolvedPath = relativePath === "" ? "." : relativePath

  // Step 4: Normalize separators (Win32 backslashes → forward slashes)
  const normalizedPath = resolvedPath.replace(/\\/g, "/")

  // Step 5: Remove "./" prefix (critical - ignore library requirement)
  const withoutPrefixPath = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath

  // Step 6: Add trailing "/" for directories (except project root)
  // This ensures directory patterns match correctly (e.g., "src/" vs "src")
  const withSlashPath = isDirectory && withoutPrefixPath !== "." && !withoutPrefixPath.endsWith("/")
    ? withoutPrefixPath + "/"
    : withoutPrefixPath

  // Step 7: Validate path format using ignore library validator
  if (!isPathValid(withSlashPath)) {
    throw new Error(`Invalid path format: ${withSlashPath}`)
  }

  return withSlashPath
}

/**
 * Check a path against loaded ignore patterns.
 *
 * Unresolvable paths (for example paths outside the project) are treated as
 * blocked: failing closed is safer than guessing.
 */
function isBlocked(
  ignoreLib: Ignore,
  targetPath: string,
  isDirectory: boolean,
  context: ProjectContext,
): boolean {
  try {
    return ignoreLib.ignores(normalizePath(targetPath, context, isDirectory))
  } catch {
    return true
  }
}

function isBlockedPath(ignoreLib: Ignore, pathInfo: PathInfo, context: ProjectContext): boolean {
  if (pathInfo.path === ".") return false

  if (pathInfo.kind === "directory") return isBlocked(ignoreLib, pathInfo.path, true, context)
  if (pathInfo.kind === "file") return isBlocked(ignoreLib, pathInfo.path, false, context)

  // OpenCode V2 reads files and directories through the same `read` tool, so
  // check both forms for tools whose target type is not known up front.
  return isBlocked(ignoreLib, pathInfo.path, false, context) ||
    isBlocked(ignoreLib, pathInfo.path, true, context)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isGlobEntry(value: unknown): value is GlobEntry {
  return isRecord(value) &&
    typeof value.path === "string" &&
    (value.type === "file" || value.type === "directory")
}

function isGrepMatch(value: unknown): value is GrepMatch {
  return isRecord(value) &&
    isGlobEntry(value.entry) &&
    typeof value.line === "number" &&
    typeof value.text === "string"
}

function formatTruncationNote(count: number): string {
  return `(Results are truncated: showing first ${count} results. Consider using a more specific path or pattern.)`
}

/**
 * Rebuild glob model content using OpenCode V2's format, but with filtered
 * entries only. Paths in content are absolute, like the original.
 */
function globContent(
  entries: readonly GlobEntry[],
  context: ProjectContext,
  truncated: boolean,
): string {
  const lines = entries.length === 0
    ? ["No files found"]
    : entries.map((entry) => resolve(context.baseDirectory, entry.path))

  if (truncated) lines.push("", formatTruncationNote(entries.length))

  return lines.join("\n")
}

/**
 * Rebuild grep model content using OpenCode V2's grouped format, but with
 * filtered matches only. Paths in content are absolute, like the original.
 */
function grepContent(
  matches: readonly GrepMatch[],
  context: ProjectContext,
  truncated: boolean,
): string {
  const lines = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  let current = ""

  for (const match of matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${resolve(context.baseDirectory, match.entry.path)}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }

  if (truncated) lines.push("", formatTruncationNote(matches.length))

  return lines.join("\n")
}

/**
 * Filter glob tool results to remove blocked entries from both the structured
 * output and the model-facing content.
 */
function filterGlobResults(result: ToolResult, ignoreLib: Ignore, context: ProjectContext): ToolResult {
  if (!Array.isArray(result.output)) return result

  const entries = result.output
    .filter(isGlobEntry)
    .filter((entry) => !isBlocked(ignoreLib, entry.path, entry.type === "directory", context))
  const truncated = result.metadata?.truncated === true

  return {
    ...result,
    output: entries,
    content: [{ type: "text", text: globContent(entries, context, truncated) }],
    metadata: { ...result.metadata, count: entries.length },
  }
}

/**
 * Filter grep tool results to remove matches from blocked files in both the
 * structured output and the model-facing content.
 */
function filterGrepResults(result: ToolResult, ignoreLib: Ignore, context: ProjectContext): ToolResult {
  if (!Array.isArray(result.output)) return result

  const matches = result.output
    .filter(isGrepMatch)
    .filter((match) => !isBlocked(ignoreLib, match.entry.path, match.entry.type === "directory", context))
  const truncated = result.metadata?.truncated === true

  return {
    ...result,
    output: matches,
    content: [{ type: "text", text: grepContent(matches, context, truncated) }],
    metadata: { ...result.metadata, matches: matches.length },
  }
}

/**
 * Filter tool results to remove paths blocked by .ignore patterns.
 * Used in the post-execution hook to prevent glob/grep from exposing
 * sensitive files through either structured output or rendered content.
 */
async function filterResults(
  tool: string,
  result: ToolResult,
  context: ProjectContext,
): Promise<ToolResult> {
  const name = tool.toLowerCase()
  if (name !== "glob" && name !== "grep") return result

  const ignoreLib = await loadIgnore(context.projectRoot)
  if (!ignoreLib) return result

  if (name === "glob") return filterGlobResults(result, ignoreLib, context)
  return filterGrepResults(result, ignoreLib, context)
}

/**
 * Extract path and kind from tool arguments.
 *
 * OpenCode V2 file tools take `path` (V1 used `filePath`); `glob` and `grep`
 * operate on a directory and default to the project root. `read` can target
 * either a file or a directory in V2, hence `any`.
 */
function extractPathsFromTool(tool: string, input: Record<string, unknown>): PathInfo[] {
  const name = tool.toLowerCase()

  if (name === "read" || name === "write" || name === "edit") {
    const path = typeof input.path === "string"
      ? input.path
      : typeof input.filePath === "string"
        ? input.filePath
        : undefined

    if (!path) return []
    return [{ path, kind: name === "read" ? "any" : "file" }]
  }

  // Directory operations - search/list within directories.
  // Default to "." (project root) if path not specified.
  if (name === "glob" || name === "grep" || name === "list") {
    const path = typeof input.path === "string" && input.path.length > 0 ? input.path : "."
    return [{ path, kind: "directory" }]
  }

  // Unknown tool - no path checking needed
  return []
}

/**
 * OpenCode V2 plugin to restrict AI access using .ignore patterns.
 *
 * Intercepts native OpenCode tools (read, write, edit, glob, grep) and blocks
 * access to paths matching patterns in the .ignore file.
 *
 * Features:
 * - Gitignore-style patterns via the ignore library
 * - Graceful degradation if .ignore is missing
 * - Project root (.) always accessible
 * - Filters both structured output and model-facing content
 *
 * @example
 * // .ignore file
 * /secrets/**
 * *.key
 * !config.local.json
 */
export const OpenCodeIgnorePlugin = async (ctx: Plugin.Context) => {
  const projectRoot = ctx.location.project.directory || ctx.location.directory
  const context: ProjectContext = {
    projectRoot,
    baseDirectory: ctx.location.directory,
  }

  /**
   * Hook that runs before any tool execution.
   * Blocks tools whose target path matches .ignore patterns.
   */
  await ctx.tool.hook("execute.before", async (payload) => {
    if (!isRecord(payload.input)) return

    const pathInfos = extractPathsFromTool(payload.tool, payload.input)
    if (pathInfos.length === 0) return

    const ignoreLib = await loadIgnore(projectRoot)
    if (!ignoreLib) return

    for (const pathInfo of pathInfos) {
      if (isBlockedPath(ignoreLib, pathInfo, context)) {
        throw new Error(
          `Access denied: ${pathInfo.path} blocked by ignore file. Do NOT try to read this. Access restricted.`,
        )
      }
    }
  })

  /**
   * Hook that runs after tool execution.
   * Filters glob/grep output and content to remove blocked files.
   */
  await ctx.tool.hook("execute.after", async (payload) => {
    if (payload.status !== "completed") return

    payload.result = await filterResults(payload.tool, payload.result, context)
  })
}

export const OpenCodeIgnore = Plugin.define({
  id: "opencode-ignore",
  setup: OpenCodeIgnorePlugin,
})

export default OpenCodeIgnore
