import {isAbsolute} from "path"

const EMPTY_RESULT = "No files found"
const GLOB_TRUNCATION_FOOTER = "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)"
const GREP_TRUNCATION_FOOTER = "(Results truncated. Consider using a more specific path or pattern.)"
const GREP_INACCESSIBLE_NOTICE = "(Some paths were inaccessible and skipped)"

type NativeToolMetadata = {
  count?: number
  matches?: number
  truncated?: boolean
  outputPath?: string
}

type NativeToolOutput = {
  output: string
  metadata: NativeToolMetadata
}

export function filterGlobResults(result: NativeToolOutput, isBlocked: (path: string) => boolean): void {
  const hasNativeFooter = result.output.endsWith(`\n\n${GLOB_TRUNCATION_FOOTER}`)
  const body = hasNativeFooter
    ? result.output.slice(0, -(`\n\n${GLOB_TRUNCATION_FOOTER}`.length))
    : result.output
  const paths = result.output === EMPTY_RESULT ? [] : body.split("\n")
  const hasValidGrammar = result.output === EMPTY_RESULT
    || (body !== "" && !body.includes("\n\n") && paths.every(isAbsolute))
  const count = result.metadata.count ?? -1
  const hasValidCount = Number.isSafeInteger(count)
    && count >= 0
    && count === paths.length
  const truncated = hasNativeFooter || result.metadata.truncated === true

  delete result.metadata.outputPath

  if (!hasValidGrammar || !hasValidCount) {
    result.output = EMPTY_RESULT
    result.metadata.count = 0
    result.metadata.truncated = truncated
    return
  }

  const visiblePaths = paths.filter((filePath) => !isBlocked(filePath))

  result.output = visiblePaths.length === 0
    ? EMPTY_RESULT
    : [...visiblePaths, ...(truncated ? ["", GLOB_TRUNCATION_FOOTER] : [])].join("\n")
  result.metadata.count = visiblePaths.length
  result.metadata.truncated = truncated
}

export function filterGrepResults(result: NativeToolOutput, isBlocked: (path: string) => boolean): void {
  const hasInaccessibleNotice = result.output.endsWith(`\n\n${GREP_INACCESSIBLE_NOTICE}`)
  const outputWithoutNotice = hasInaccessibleNotice
    ? result.output.slice(0, -(`\n\n${GREP_INACCESSIBLE_NOTICE}`.length))
    : result.output
  const legacyOutput = outputWithoutNotice.match(/^(.*)\n\n\(Results truncated: showing (\d+) of (\d+) matches \((\d+) hidden\)\. Consider using a more specific path or pattern\.\)$/s)
  const hasNativeFooter = !legacyOutput && outputWithoutNotice.endsWith(`\n\n${GREP_TRUNCATION_FOOTER}`)
  const body = legacyOutput?.[1] ?? (hasNativeFooter
    ? outputWithoutNotice.slice(0, -(`\n\n${GREP_TRUNCATION_FOOTER}`.length))
    : outputWithoutNotice)
  const headerEnd = body.indexOf("\n")
  const currentHeader = headerEnd === -1 ? null : body.slice(0, headerEnd).match(/^Found (\d+) matches( \(more matches available\))?$/)
  const legacyHeader = headerEnd === -1 ? null : body.slice(0, headerEnd).match(/^Found (\d+) matches \(showing first (\d+)\)$/)
  const groupBody = headerEnd === -1 ? "" : body.slice(headerEnd + 1)
  const groups = groupBody === "" ? [] : groupBody.split("\n\n").map((group) => {
    const lines = group.split("\n")
    const groupHeader = lines[0] ?? ""
    const groupPath = groupHeader.endsWith(":") ? groupHeader.slice(0, -1) : ""
    const rows = lines.slice(1)

    return {
      path: groupPath,
      rows,
      valid: isAbsolute(groupPath) && rows.length > 0 && rows.every((row) => /^  Line \d+: .*$/.test(row)),
    }
  })
  const sourceMatches = groups.reduce((total, group) => total + group.rows.length, 0)
  const declaredMatches = currentHeader ? Number(currentHeader[1]) : -1
  const legacyHeaderTotal = legacyHeader ? Number(legacyHeader[1]) : -1
  const legacyHeaderShown = legacyHeader ? Number(legacyHeader[2]) : -1
  const legacyFooterShown = legacyOutput ? Number(legacyOutput[2]) : -1
  const legacyFooterTotal = legacyOutput ? Number(legacyOutput[3]) : -1
  const legacyFooterHidden = legacyOutput ? Number(legacyOutput[4]) : -1
  const matches = result.metadata.matches ?? -1
  const hasValidGrammar = outputWithoutNotice === EMPTY_RESULT
    || ((currentHeader !== null || legacyHeader !== null) && groupBody !== "" && groups.every((group) => group.valid))
  const hasCurrentCount = !legacyOutput
    && Number.isSafeInteger(declaredMatches)
    && declaredMatches >= 0
    && declaredMatches === sourceMatches
    && Number.isSafeInteger(matches)
    && matches === sourceMatches
  const hasLegacyCount = legacyHeader !== null
    && legacyOutput !== null
    && legacyHeaderShown === 100
    && legacyFooterShown === legacyHeaderShown
    && legacyFooterTotal === legacyHeaderTotal
    && legacyFooterHidden === legacyHeaderTotal - legacyHeaderShown
    && legacyHeaderTotal > legacyHeaderShown
    && sourceMatches === legacyHeaderShown
    && Number.isSafeInteger(matches)
    && matches === legacyHeaderTotal
  const hasValidCount = hasCurrentCount || hasLegacyCount
  const truncated = hasNativeFooter || currentHeader?.[2] !== undefined || legacyHeader !== null || legacyOutput !== null || result.metadata.truncated === true

  delete result.metadata.outputPath

  if (!hasValidGrammar || !hasValidCount) {
    result.output = EMPTY_RESULT
    result.metadata.matches = 0
    result.metadata.truncated = truncated
    return
  }

  if (outputWithoutNotice === EMPTY_RESULT) {
    result.metadata.matches = 0
    result.metadata.truncated = truncated
    return
  }

  const visibleGroups = groups.filter((group) => !isBlocked(group.path))
  const visibleMatches = visibleGroups.reduce((total, group) => total + group.rows.length, 0)

  result.output = visibleMatches === 0
    ? EMPTY_RESULT
    : [
        `Found ${visibleMatches} matches${truncated ? " (more matches available)" : ""}`,
        visibleGroups.map((group) => [`${group.path}:`, ...group.rows].join("\n")).join("\n\n"),
        ...(truncated ? ["", GREP_TRUNCATION_FOOTER] : []),
        ...(hasInaccessibleNotice ? ["", GREP_INACCESSIBLE_NOTICE] : []),
      ].join("\n")
  result.metadata.matches = visibleMatches
  result.metadata.truncated = truncated
}
