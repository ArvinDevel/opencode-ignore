import type {PluginOptions} from "@opencode-ai/plugin"
import path from "path"
import {OpenCodeIgnore} from "./index"

type OpenCodeIgnorePlugin = Awaited<ReturnType<typeof OpenCodeIgnore>>

export type ToolBeforeHook = OpenCodeIgnorePlugin["tool.execute.before"]
export type ToolAfterHook = OpenCodeIgnorePlugin["tool.execute.after"]

export type ToolArguments = {
  filePath?: string
  path?: string
  pattern?: string
  somePath?: string
}
export type NativeMetadata = {
  count?: number
  matches?: number
  truncated?: boolean
  outputPath?: string
  trace?: string
  source?: string
}

export type NativeToolOutput = {
  title: string
  output: string
  metadata: NativeMetadata
}

export const TEST_PROJECT_ROOT = path.join(process.cwd(), "test-data")

export async function createPlugin(projectRoot = TEST_PROJECT_ROOT, options: PluginOptions = {}) {
  return OpenCodeIgnore({
    directory: projectRoot,
    worktree: projectRoot,
  }, options)
}

export async function callHook(hook: ToolBeforeHook, tool: string, args: ToolArguments) {
  return hook(
    {tool, sessionID: "test", callID: "test"},
    {args},
  )
}

export async function callAfterHook(
  hook: ToolAfterHook,
  tool: string,
  args: ToolArguments,
  output: NativeToolOutput,
) {
  return hook(
    {tool, sessionID: "test", callID: "test", args},
    output,
  )
}
