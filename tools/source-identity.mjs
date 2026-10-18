import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoots = ["web/app", "web/build", "web/server", "web/contracts", "tools"];
const sourceFiles = ["web/package.json", "web/pnpm-lock.yaml", "web/vite.config.ts", "requirements.txt", "web/scripts/live-shadow-v2.py", "web/scripts/invoke-live-shadow-step.ps1", "web/scripts/setup-finnhub.ps1", "web/scripts/reselect-paper-plans.ts"];
const required = ["web/app/snapshot-import.ts", "web/build/local-data-core.ts", "web/server/local-owner-server.ts", "tools/source-identity.mjs", "v2-reference/trading_os_v2/orchestrator/service.py", "v2-reference/trading_os_v2/common/config.py", "v2-reference/contracts/v2/ts-output.schema.json", "v2-reference/config/system.json", "web/dist/server/index.js"];
const ignored = new Set(["__pycache__", ".pytest_cache", "node_modules"]);
const forbidden = new Set(["data", "runtime", ".git", ".codex", ".venv", "node_modules", "_工作文件", "release"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function checkedPath(root, path) {
  if (typeof path !== "string" || !path || /[\\:\x00-\x1f]/.test(path) || isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || forbidden.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env") || /^\.?(?:auth|credentials)\.json$|\.(?:sqlite\w*|db|pem|pfx|p12|key|log)$/i.test(part))) throw new Error("SOURCE_IDENTITY_PATH_INVALID");
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new Error("SOURCE_IDENTITY_PATH_ESCAPE");
  for (let current = target; current !== root; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error("SOURCE_IDENTITY_LINK_FORBIDDEN");
  }
  return target;
}

function walk(root, path, accept = () => true, skipCaches = true) {
  const target = checkedPath(root, path), entries = readdirSync(target, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const next = `${path}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("SOURCE_IDENTITY_LINK_FORBIDDEN");
    if (entry.isDirectory()) return skipCaches && ignored.has(entry.name) ? [] : walk(root, next, accept, skipCaches);
    if (!entry.isFile()) throw new Error("SOURCE_IDENTITY_FILE_INVALID");
    checkedPath(root, next);
    return accept(next) ? [next] : [];
  });
}

function digestPaths(root, paths, relativeTo = "") {
  const digest = createHash("sha256");
  for (const path of [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const name = relativeTo ? path.slice(relativeTo.length + 1) : path;
    digest.update(name + "\0");
    digest.update(readFileSync(checkedPath(root, path)));
  }
  return digest.digest("hex");
}

function manifestStatus(root, paths) {
  let stat;
  try { stat = lstatSync(resolve(root, "SOURCE-MANIFEST.json")); }
  catch (error) { if (error.code === "ENOENT") return "ABSENT_LOCAL_CONTENT_ONLY"; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("SOURCE_MANIFEST_LINK_FORBIDDEN");
  const manifest = JSON.parse(readFileSync(resolve(root, "SOURCE-MANIFEST.json"), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("SOURCE_MANIFEST_FORMAT_INVALID");
  const listed = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || listed.has(entry.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("SOURCE_MANIFEST_ENTRY_INVALID");
    const target = checkedPath(root, entry.path), data = readFileSync(target);
    if (!lstatSync(target).isFile() || data.length !== entry.bytes || hash(data) !== entry.sha256) throw new Error("SOURCE_MANIFEST_CONTENT_MISMATCH");
    listed.add(entry.path.toLowerCase());
  }
  if (paths.some((path) => !listed.has(path.toLowerCase()))) throw new Error("SOURCE_MANIFEST_REQUIRED_FILE_MISSING");
  return "VALIDATED_LOCAL_CONTENT_ONLY";
}

function sourceOrigin(root) {
  let stat;
  try { stat = lstatSync(resolve(root, ".git")); }
  catch (error) { if (error.code === "ENOENT") return { kind: "SOURCE_ARCHIVE", head_commit: null, dirty: null }; throw error; }
  // Never follow a worktree .git file/link or let Git discover a parent repository.
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: "GIT_METADATA_UNAVAILABLE", head_commit: null, dirty: null };
  let commit = null;
  try {
    const gitRoot = resolve(root, ".git"), read = (path) => {
      const target = checkedPath(gitRoot, path), info = lstatSync(target);
      if (!info.isFile() || info.size > 4096) throw new Error("GIT_METADATA_INVALID");
      return readFileSync(target, "utf8").trim();
    };
    const head = read("HEAD"), ref = /^ref: (refs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9._-]+)$/.exec(head);
    const value = ref ? read(ref[1]) : head;
    if (/^[a-f0-9]{40}$/.test(value)) commit = value;
  } catch { /* Optional origin only: never follow external metadata, config or packed repositories. */ }
  // Dirty state is deliberately not inspected; HEAD does not identify the running source bytes.
  return { kind: "GIT_CHECKOUT", head_commit: commit, dirty: null };
}

export function currentPackageRoot() {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(directory, ".."), resolve(directory, "../../..")]) {
    try { if (lstatSync(resolve(root, "tools/source-identity.mjs")).isFile() && lstatSync(resolve(root, "web/scripts/live-shadow-v2.py")).isFile()) return root; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("SOURCE_IDENTITY_PACKAGE_ROOT_MISSING");
}

/** Local content consistency only: not a publisher signature, clean Git proof or prediction advantage. */
export function readBundledSourceIdentity(packageRoot = currentPackageRoot()) {
  const root = resolve(packageRoot);
  const canonical = realpathSync(root), sameRoot = process.platform === "win32" ? canonical.toLowerCase() === root.toLowerCase() : canonical === root;
  if (!sameRoot || lstatSync(root).isSymbolicLink()) throw new Error("SOURCE_IDENTITY_ROOT_LINK_FORBIDDEN");
  for (const path of required) if (!lstatSync(checkedPath(root, path)).isFile()) throw new Error("SOURCE_IDENTITY_REQUIRED_FILE_MISSING");
  const core = [...walk(root, "v2-reference/trading_os_v2", (path) => /\.(py|md)$/.test(path)), ...walk(root, "v2-reference/contracts", (path) => path.endsWith(".json")), "v2-reference/config/system.json"];
  const sources = [...new Set([...core, ...sourceFiles, ...sourceRoots.flatMap((path) => walk(root, path))])].sort();
  const runtime = [...walk(root, "web/dist/server", () => true, false), ...walk(root, "web/dist/client", () => true, false)].sort();
  if (!runtime.some((path) => path.startsWith("web/dist/client/"))) throw new Error("SOURCE_IDENTITY_CLIENT_MISSING");
  return {
    kind: "BUNDLED_SOURCE_SHA256", core_sha256: digestPaths(root, core, "v2-reference"), source_sha256: digestPaths(root, sources), runtime_sha256: digestPaths(root, runtime),
    source_origin: sourceOrigin(root), manifest_status: manifestStatus(root, sources),
  };
}

/** A caller-provided digest is only a claim; compare against the current actual package bytes. */
export function verifyBundledSourceIdentity(claim, modelSourceSha256) {
  try {
    const expected = typeof claim === "string" ? JSON.parse(claim) : claim;
    if (!expected || expected.kind !== "BUNDLED_SOURCE_SHA256") return null;
    const actual = readBundledSourceIdentity();
    return modelSourceSha256 === actual.core_sha256 && JSON.stringify(expected) === JSON.stringify(actual) ? actual : null;
  } catch { return null; }
}
