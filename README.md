# opencode-ignore

OpenCode plugin to restrict AI access to files and directories using `.ignore` patterns (gitignore-style).

> **Disclaimer:** `opencode-ignore` is an independent project. It is not built by the OpenCode team and is not affiliated with OpenCode.

## Compatibility

| opencode-ignore | OpenCode |
| --- | --- |
| `2.x` | `2.x` |
| `1.x` | `1.x` |

OpenCode V1 plugins do not run in V2, so upgrade the plugin when you upgrade OpenCode.

## Usage

Add to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-ignore"
  ]
}
```

Create a `.ignore` file in your project root with patterns to block:

```gitignore
# Block specific directory
/secrets/**

# Block all certificate files
*.crt
*.key
*.pem

# Block environment files
.env*

# Allow exception with negation
!config.local.json
```

## `.ignore` Format

The `.ignore` file follows gitignore-style syntax powered by the [`ignore`](https://github.com/kaelzhang/node-ignore) package.

### Pattern Types

#### Absolute Paths
Block specific paths from project root:
```gitignore
/to/ignore
/somedir/toignore/**
```

#### Glob Patterns
Block files matching patterns anywhere in project:
```gitignore
**/node_modules/**
**/dist/**
**/build/**
**/.cache/**
```

#### Wildcards
Block files by extension or name pattern:
```gitignore
*.crt              # All certificate files
*.key              # All private keys
*.pem              # All PEM files
*-secret.json      # Files ending with "-secret.json"
temp*.log          # Temp log files
```

#### Negation Patterns
Allow exceptions to blocked patterns:
```gitignore
*.json              # Block all JSON files
!*.local.json       # But allow *.local.json files

**/target/**        # Block target directory
!**/target/**       # Re-allow it (negation)
```

### Directory vs File Matching

The `ignore` library automatically detects whether paths are files or directories:

```gitignore
foo      # Blocks file "foo" OR directory "foo/"
foo/     # Only blocks directory "foo/"
```

**Important**: Pattern `**/node_modules/**` blocks files *inside* the directory, not the directory itself. Use `**/node_modules/` or `**/node_modules` if you also want to block listing the directory.

## Example Patterns

See `test-data/.ignore` for a comprehensive example:

```gitignore
# Block specific paths
/secrets/**
/private/**
!/private/public-config.json

# Block directories anywhere
**/node_modules/**
**/dist/**
**/build/**
**/.cache/**

# Block sensitive files
*-secret.json
temp*.log
*.crt
*.key
*.pem
.env*
.env
*.env
id_rsa
id_ed25519
secrets.json
credentials.json
api-keys.json

# Allow build artifacts in specific cases (negation)
!**/dist/public/**

# Allow local development files
!*.local.json
!*.dev.json
!config.development.json
!/.local/
```

## Supported Tools

The plugin protects the following OpenCode native tools:

### File Operations (Pre-execution blocking)
- `read` - Blocks reading blocked files and listing blocked directories
- `write` - Blocks writing to blocked paths
- `edit` - Blocks editing blocked files

### Search Operations (Pre-execution + Post-execution filtering)
- `glob` - Blocks searching in blocked directories, filters blocked files from results
- `grep` - Blocks searching in blocked directories, filters matches from blocked files

**Protection Levels**:
- **Pre-execution**: Prevents tools from accessing blocked paths entirely (read, write, edit)
- **Post-execution**: Allows searches in allowed directories, then removes blocked files from both the structured result and the model-facing text
- This two-phase approach prevents direct access and information disclosure

**Note**: Project root (`.`) is always accessible to prevent blocking the entire project.

## Scope and Limitations

This plugin is a guardrail for the built-in file and search tools, **not a sandbox**:

- Shell commands (`shell`) are not inspected. A command such as `cat secrets.json` is not blocked by this plugin.
- Paths that cannot be resolved inside the project (for example, external absolute paths) fail closed: they are treated as blocked.
- If `.ignore` is missing, all access is allowed.
- Paths are matched by the `ignore` library, so pattern semantics are exactly gitignore semantics.

For a hard security boundary, combine this plugin with OS-level sandboxing and keep secrets out of the agent's filesystem scope.

## How It Works

### Pre-execution Protection
1. Plugin loads `.ignore` from the project root before tool execution
2. Tool paths are normalized to relative paths from the project root
3. Paths are checked against ignore patterns using the `ignore` library
4. If matched, tool execution is blocked with a clear error message

### Post-execution Filtering (glob/grep)
For `glob` and `grep`, additional protection filters results:
1. Tool executes normally (searching allowed directories)
2. Blocked entries are removed from the structured `output`
3. Model-facing `content` is rebuilt from the remaining entries, so blocked paths do not leak through the rendered text
4. Empty results are returned if all entries are filtered

### Graceful Degradation
- If `.ignore` is missing, all access is allowed
- Project root (`.`) is always accessible

### Error Messages

When a path is blocked:
```
Access denied: path/to/file blocked by ignore file. Do NOT try to read this. Access restricted.
```

## Path Normalization

The plugin handles various path formats:

- **Absolute paths**: Converted to relative from project root
- **Relative paths**: Resolved against the active OpenCode directory
- **Paths with `./`**: Prefix removed (ignore library requirement)
- **Win32 backslashes**: Auto-converted to forward slashes
- **Directory paths**: Trailing `/` added when needed

## Testing

Run tests with:
```bash
bun test
```

Tests cover:
- Absolute path patterns
- Glob patterns
- Negation patterns
- Wildcard patterns
- Directory vs file matching
- Path normalization edge cases
- All supported native tools
- Missing `.ignore` graceful degradation
- `glob`/`grep` output and content filtering

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type-check
bunx tsc --noEmit

# Build
bun run build
```

## License

MIT

## Related

- [`ignore`](https://github.com/kaelzhang/node-ignore) - The underlying pattern matching library
- [OpenCode Plugin Documentation](https://opencode.ai/docs/plugins)
