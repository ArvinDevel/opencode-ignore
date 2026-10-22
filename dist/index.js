var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// node_modules/ignore/index.js
var require_ignore = __commonJS((exports, module) => {
  function makeArray(subject) {
    return Array.isArray(subject) ? subject : [subject];
  }
  var UNDEFINED = undefined;
  var EMPTY = "";
  var SPACE = " ";
  var ESCAPE = "\\";
  var REGEX_TEST_BLANK_LINE = /^\s+$/;
  var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
  var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
  var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
  var REGEX_SPLITALL_CRLF = /\r?\n/g;
  var REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;
  var REGEX_TEST_TRAILING_SLASH = /\/$/;
  var SLASH = "/";
  var TMP_KEY_IGNORE = "node-ignore";
  if (typeof Symbol !== "undefined") {
    TMP_KEY_IGNORE = Symbol.for("node-ignore");
  }
  var KEY_IGNORE = TMP_KEY_IGNORE;
  var define = (object, key, value) => {
    Object.defineProperty(object, key, { value });
    return value;
  };
  var REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
  var RETURN_FALSE = () => false;
  var sanitizeRange = (range) => range.replace(REGEX_REGEXP_RANGE, (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY);
  var cleanRangeBackSlash = (slashes) => {
    const { length } = slashes;
    return slashes.slice(0, length - length % 2);
  };
  var REPLACERS = [
    [
      /^\uFEFF/,
      () => EMPTY
    ],
    [
      /((?:\\\\)*?)(\\?\s+)$/,
      (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
    ],
    [
      /(\\+?)\s/g,
      (_, m1) => {
        const { length } = m1;
        return m1.slice(0, length - length % 2) + SPACE;
      }
    ],
    [
      /[\\$.|*+(){^]/g,
      (match) => `\\${match}`
    ],
    [
      /(?!\\)\?/g,
      () => "[^/]"
    ],
    [
      /^\//,
      () => "^"
    ],
    [
      /\//g,
      () => "\\/"
    ],
    [
      /^\^*\\\*\\\*\\\//,
      () => "^(?:.*\\/)?"
    ],
    [
      /^(?=[^^])/,
      function startingReplacer() {
        return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
      }
    ],
    [
      /\\\/\\\*\\\*(?=\\\/|$)/g,
      (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"
    ],
    [
      /(^|[^\\]+)(\\\*)+(?=.+)/g,
      (_, p1, p2) => {
        const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
        return p1 + unescaped;
      }
    ],
    [
      /\\\\\\(?=[$.|*+(){^])/g,
      () => ESCAPE
    ],
    [
      /\\\\/g,
      () => ESCAPE
    ],
    [
      /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
      (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${sanitizeRange(range)}${endEscape}]` : "[]" : "[]"
    ],
    [
      /(?:[^*])$/,
      (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`
    ]
  ];
  var REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
  var MODE_IGNORE = "regex";
  var MODE_CHECK_IGNORE = "checkRegex";
  var UNDERSCORE = "_";
  var TRAILING_WILD_CARD_REPLACERS = {
    [MODE_IGNORE](_, p1) {
      const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
      return `${prefix}(?=$|\\/$)`;
    },
    [MODE_CHECK_IGNORE](_, p1) {
      const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
      return `${prefix}(?=$|\\/$)`;
    }
  };
  var makeRegexPrefix = (pattern) => REPLACERS.reduce((prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)), pattern);
  var isString = (subject) => typeof subject === "string";
  var checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
  var splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);

  class IgnoreRule {
    constructor(pattern, mark, body, ignoreCase, negative, prefix) {
      this.pattern = pattern;
      this.mark = mark;
      this.negative = negative;
      define(this, "body", body);
      define(this, "ignoreCase", ignoreCase);
      define(this, "regexPrefix", prefix);
    }
    get regex() {
      const key = UNDERSCORE + MODE_IGNORE;
      if (this[key]) {
        return this[key];
      }
      return this._make(MODE_IGNORE, key);
    }
    get checkRegex() {
      const key = UNDERSCORE + MODE_CHECK_IGNORE;
      if (this[key]) {
        return this[key];
      }
      return this._make(MODE_CHECK_IGNORE, key);
    }
    _make(mode, key) {
      const str = this.regexPrefix.replace(REGEX_REPLACE_TRAILING_WILDCARD, TRAILING_WILD_CARD_REPLACERS[mode]);
      const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
      return define(this, key, regex);
    }
  }
  var createRule = ({
    pattern,
    mark
  }, ignoreCase) => {
    let negative = false;
    let body = pattern;
    if (body.indexOf("!") === 0) {
      negative = true;
      body = body.substr(1);
    }
    body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
    const regexPrefix = makeRegexPrefix(body);
    return new IgnoreRule(pattern, mark, body, ignoreCase, negative, regexPrefix);
  };

  class RuleManager {
    constructor(ignoreCase) {
      this._ignoreCase = ignoreCase;
      this._rules = [];
    }
    _add(pattern) {
      if (pattern && pattern[KEY_IGNORE]) {
        this._rules = this._rules.concat(pattern._rules._rules);
        this._added = true;
        return;
      }
      if (isString(pattern)) {
        pattern = {
          pattern
        };
      }
      if (checkPattern(pattern.pattern)) {
        const rule = createRule(pattern, this._ignoreCase);
        this._added = true;
        this._rules.push(rule);
      }
    }
    add(pattern) {
      this._added = false;
      makeArray(isString(pattern) ? splitPattern(pattern) : pattern).forEach(this._add, this);
      return this._added;
    }
    test(path, checkUnignored, mode) {
      let ignored = false;
      let unignored = false;
      let matchedRule;
      this._rules.forEach((rule) => {
        const { negative } = rule;
        if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) {
          return;
        }
        const matched = rule[mode].test(path);
        if (!matched) {
          return;
        }
        ignored = !negative;
        unignored = negative;
        matchedRule = negative ? UNDEFINED : rule;
      });
      const ret = {
        ignored,
        unignored
      };
      if (matchedRule) {
        ret.rule = matchedRule;
      }
      return ret;
    }
  }
  var throwError = (message, Ctor) => {
    throw new Ctor(message);
  };
  var checkPath = (path, originalPath, doThrow) => {
    if (!isString(path)) {
      return doThrow(`path must be a string, but got \`${originalPath}\``, TypeError);
    }
    if (!path) {
      return doThrow(`path must not be empty`, TypeError);
    }
    if (checkPath.isNotRelative(path)) {
      const r = "`path.relative()`d";
      return doThrow(`path should be a ${r} string, but got "${originalPath}"`, RangeError);
    }
    return true;
  };
  var isNotRelative = (path) => REGEX_TEST_INVALID_PATH.test(path);
  checkPath.isNotRelative = isNotRelative;
  checkPath.convert = (p) => p;

  class Ignore {
    constructor({
      ignorecase = true,
      ignoreCase = ignorecase,
      allowRelativePaths = false
    } = {}) {
      define(this, KEY_IGNORE, true);
      this._rules = new RuleManager(ignoreCase);
      this._strictPathCheck = !allowRelativePaths;
      this._initCache();
    }
    _initCache() {
      this._ignoreCache = Object.create(null);
      this._testCache = Object.create(null);
    }
    add(pattern) {
      if (this._rules.add(pattern)) {
        this._initCache();
      }
      return this;
    }
    addPattern(pattern) {
      return this.add(pattern);
    }
    _test(originalPath, cache, checkUnignored, slices) {
      const path = originalPath && checkPath.convert(originalPath);
      checkPath(path, originalPath, this._strictPathCheck ? throwError : RETURN_FALSE);
      return this._t(path, cache, checkUnignored, slices);
    }
    checkIgnore(path) {
      if (!REGEX_TEST_TRAILING_SLASH.test(path)) {
        return this.test(path);
      }
      const slices = path.split(SLASH).filter(Boolean);
      slices.pop();
      if (slices.length) {
        const parent = this._t(slices.join(SLASH) + SLASH, this._testCache, true, slices);
        if (parent.ignored) {
          return parent;
        }
      }
      return this._rules.test(path, false, MODE_CHECK_IGNORE);
    }
    _t(path, cache, checkUnignored, slices) {
      if (path in cache) {
        return cache[path];
      }
      if (!slices) {
        slices = path.split(SLASH).filter(Boolean);
      }
      slices.pop();
      if (!slices.length) {
        return cache[path] = this._rules.test(path, checkUnignored, MODE_IGNORE);
      }
      const parent = this._t(slices.join(SLASH) + SLASH, cache, checkUnignored, slices);
      return cache[path] = parent.ignored ? parent : this._rules.test(path, checkUnignored, MODE_IGNORE);
    }
    ignores(path) {
      return this._test(path, this._ignoreCache, false).ignored;
    }
    createFilter() {
      return (path) => !this.ignores(path);
    }
    filter(paths) {
      return makeArray(paths).filter(this.createFilter());
    }
    test(path) {
      return this._test(path, this._testCache, true);
    }
  }
  var factory = (options) => new Ignore(options);
  var isPathValid = (path) => checkPath(path && checkPath.convert(path), path, RETURN_FALSE);
  var setupWindows = () => {
    const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
    checkPath.convert = makePosix;
    const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
    checkPath.isNotRelative = (path) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
  };
  if (typeof process !== "undefined" && process.platform === "win32") {
    setupWindows();
  }
  module.exports = factory;
  factory.default = factory;
  module.exports.isPathValid = isPathValid;
  define(module.exports, Symbol.for("setupWindows"), setupWindows);
});

// index.ts
var import_ignore = __toESM(require_ignore(), 1);
var import_ignore2 = __toESM(require_ignore(), 1);
import { Plugin } from "@opencode/plugin";
import { join, isAbsolute, relative, dirname } from "path";
import { stat, readFile } from "node:fs/promises";
async function findIgnore(directory, stopAt) {
  const source = await readFile(join(directory, ".ignore"), "utf8").catch((error) => {
    if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR")
      return null;
    throw error;
  });
  if (source !== null) {
    const lib = import_ignore.default();
    lib.add(source);
    return { lib, root: directory };
  }
  if (directory === stopAt)
    return null;
  const parent = dirname(directory);
  if (parent === directory)
    return null;
  return findIgnore(parent, stopAt);
}
function toAbsolute(targetPath, resolveDir) {
  return isAbsolute(targetPath) ? targetPath : join(resolveDir, targetPath);
}
async function pathIsDirectory(absolutePath) {
  const info = await stat(absolutePath).catch(() => {
    return;
  });
  if (!info)
    return;
  return info.isDirectory();
}
function normalizePath(targetPath, resolveDir, ignoreRoot, isDirectory) {
  const absolutePath = toAbsolute(targetPath, resolveDir);
  const relativePath = relative(ignoreRoot, absolutePath);
  if (relativePath === "")
    return ".";
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const withoutPrefixPath = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath;
  const withSlashPath = isDirectory && !withoutPrefixPath.endsWith("/") ? withoutPrefixPath + "/" : withoutPrefixPath;
  if (!import_ignore2.isPathValid(withSlashPath)) {
    throw new Error(`Invalid path format: ${withSlashPath}`);
  }
  return withSlashPath;
}
function isBlocked(targetPath, source, resolveDir, isDirectory) {
  try {
    const normalized = normalizePath(targetPath, resolveDir, source.root, isDirectory);
    if (normalized === ".")
      return false;
    return source.lib.ignores(normalized);
  } catch {
    return true;
  }
}
var PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
var PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/gm;
function extractPatchPaths(patchText) {
  const paths = [];
  for (const match of patchText.matchAll(PATCH_FILE_HEADER)) {
    if (match[1])
      paths.push(match[1].trim());
  }
  for (const match of patchText.matchAll(PATCH_MOVE_HEADER)) {
    if (match[1])
      paths.push(match[1].trim());
  }
  return paths;
}
async function extractPaths(tool, args, resolveDir) {
  if (tool === "read") {
    const target = args.path;
    if (typeof target !== "string" || target === "")
      return [];
    const isDirectory = await pathIsDirectory(toAbsolute(target, resolveDir)) ?? false;
    return [{ path: target, isDirectory }];
  }
  if (tool === "write" || tool === "edit") {
    const target = args.path;
    if (typeof target !== "string" || target === "")
      return [];
    return [{ path: target, isDirectory: false }];
  }
  if (tool === "glob" || tool === "grep") {
    const target = typeof args.path === "string" && args.path !== "" ? args.path : ".";
    const isDirectory = await pathIsDirectory(toAbsolute(target, resolveDir)) ?? true;
    return [{ path: target, isDirectory }];
  }
  if (tool === "patch") {
    const patchText = args.patchText;
    if (typeof patchText !== "string")
      return [];
    return extractPatchPaths(patchText).map((target) => ({ path: target, isDirectory: false }));
  }
  return [];
}
function filterGlobOutput(output, source, resolveDir) {
  const kept = [];
  let total = 0;
  for (const line of output.split(`
`)) {
    if (line === "" || line === "No files found")
      continue;
    if (line.startsWith("("))
      continue;
    total += 1;
    if (!isBlocked(line, source, resolveDir, false))
      kept.push(line);
  }
  if (total === 0 || kept.length === total)
    return { output, count: kept.length, filtered: false };
  if (kept.length === 0)
    return { output: "No files found", count: 0, filtered: true };
  return { output: kept.join(`
`), count: kept.length, filtered: true };
}
function filterGrepOutput(output, source, resolveDir) {
  const lines = output.split(`
`);
  const summary = /^Found (\d+) matches( \(more matches available\))?$/.exec(lines[0] ?? "");
  if (!summary)
    return { output, count: 0, filtered: false };
  const originalTotal = Number(summary[1]);
  const blocks = [];
  let current;
  for (const line of lines.slice(1)) {
    if (line === "")
      continue;
    if (line.startsWith("(")) {
      current = undefined;
      continue;
    }
    if (!line.startsWith("  ") && line.endsWith(":")) {
      current = { path: line.slice(0, -1), lines: [] };
      blocks.push(current);
      continue;
    }
    if (current)
      current.lines.push(line);
  }
  const keptBlocks = blocks.filter((block) => !isBlocked(block.path, source, resolveDir, false));
  const count = keptBlocks.reduce((total, block) => total + block.lines.length, 0);
  if (count === originalTotal)
    return { output, count, filtered: false };
  if (count === 0)
    return { output: "No files found", count: 0, filtered: true };
  const rebuilt = [`Found ${count} matches`];
  for (const [index, block] of keptBlocks.entries()) {
    if (index > 0)
      rebuilt.push("");
    rebuilt.push(`${block.path}:`);
    rebuilt.push(...block.lines);
  }
  return { output: rebuilt.join(`
`), count, filtered: true };
}
function entryPath(entry, tool) {
  if (entry === null || typeof entry !== "object")
    return;
  if (tool === "glob") {
    const path2 = entry.path;
    return typeof path2 === "string" ? path2 : undefined;
  }
  const inner = entry.entry;
  if (inner === null || typeof inner !== "object")
    return;
  const path = inner.path;
  return typeof path === "string" ? path : undefined;
}
function filterResultValue(tool, value, source, resolveDir) {
  if (typeof value === "string") {
    const filtered = tool === "glob" ? filterGlobOutput(value, source, resolveDir) : filterGrepOutput(value, source, resolveDir);
    return { value: filtered.output, count: filtered.count, filtered: filtered.filtered };
  }
  if (!Array.isArray(value))
    return { value, count: 0, filtered: false };
  const kept = value.filter((entry) => {
    const path = entryPath(entry, tool);
    if (path === undefined)
      return true;
    const isDirectory = tool === "glob" && entry.type === "directory";
    return !isBlocked(path, source, resolveDir, isDirectory);
  });
  if (kept.length === value.length)
    return { value, count: value.length, filtered: false };
  return { value: kept, count: kept.length, filtered: true };
}
function filterResultContent(tool, content, source, resolveDir) {
  if (typeof content === "string") {
    const filtered = tool === "glob" ? filterGlobOutput(content, source, resolveDir) : filterGrepOutput(content, source, resolveDir);
    return { value: filtered.output, count: filtered.count, filtered: filtered.filtered };
  }
  if (!Array.isArray(content))
    return { value: content, count: 0, filtered: false };
  let count = 0;
  let anyFiltered = false;
  const kept = content.map((item) => {
    if (item === null || typeof item !== "object")
      return item;
    const block = item;
    if (block.type !== "text" || typeof block.text !== "string")
      return item;
    const filtered = tool === "glob" ? filterGlobOutput(block.text, source, resolveDir) : filterGrepOutput(block.text, source, resolveDir);
    if (!filtered.filtered)
      return item;
    anyFiltered = true;
    count += filtered.count;
    return { ...block, text: filtered.output };
  });
  return { value: anyFiltered ? kept : content, count, filtered: anyFiltered };
}
var opencode_ignore_default = Plugin.define({
  id: "opencode-ignore",
  async setup(ctx) {
    const resolveDir = ctx.location.directory;
    const stopAt = ctx.location.project.canonical;
    await ctx.tool.hook("execute.before", async (event) => {
      const source = await findIgnore(resolveDir, stopAt);
      if (!source)
        return;
      const input = event.input;
      if (!input || typeof input !== "object")
        return;
      const paths = await extractPaths(event.tool, input, resolveDir);
      for (const info of paths) {
        const normalized = normalizePath(info.path, resolveDir, source.root, info.isDirectory);
        if (normalized === ".")
          continue;
        if (source.lib.ignores(normalized)) {
          throw new Error(`Access denied: ${info.path} blocked by ignore file. Do NOT try to read this. Access restricted.`);
        }
      }
    });
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed")
        return;
      if (event.tool !== "glob" && event.tool !== "grep")
        return;
      const source = await findIgnore(resolveDir, stopAt);
      if (!source)
        return;
      const result = event.result;
      const output = filterResultValue(event.tool, result.output, source, resolveDir);
      const content = filterResultContent(event.tool, result.content, source, resolveDir);
      if (!output.filtered && !content.filtered)
        return;
      const filtered = output.filtered ? output : content;
      const metadata = { ...result.metadata ?? {}, truncated: false };
      if (event.tool === "glob")
        metadata.count = filtered.count;
      else
        metadata.matches = filtered.count;
      const next = { ...result, metadata };
      if (output.filtered)
        next.output = output.value;
      if (content.filtered)
        next.content = content.value;
      if (output.filtered && result.content !== undefined && !content.filtered)
        delete next.content;
      if (content.filtered && result.output !== undefined && !output.filtered)
        delete next.output;
      event.result = next;
    });
  }
});
export {
  opencode_ignore_default as default
};
