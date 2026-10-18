import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const publicAutomationEnabled = () => process.env.TRADING_OS_PUBLIC_AUTOMATION === "1";

export function publicResearchConfigured(projectRoot: string) {
  const path = resolve(projectRoot, "data", "public-setup.json");
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
    return JSON.parse(readFileSync(path, "utf8")).research_profile_completed === true;
  } catch { return false; }
}

/** Each copy owns its profiles; never fall back to the user's global Codex login. */
export function publicProfile(projectRoot: string, kind: "model" | "broker") {
  const data = resolve(projectRoot, "data"), profile = resolve(data, kind === "model" ? "model-codex-home" : "robinhood-codex-home");
  for (const path of [data, profile, resolve(profile, "auth.json"), resolve(profile, ".credentials.json"), resolve(profile, "credentials.json"), resolve(profile, "config.toml")]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("PUBLIC_PROFILE_LINK_FORBIDDEN"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return profile;
}

export function assertPublicAutomation() {
  if (!publicAutomationEnabled()) throw new Error("PUBLIC_AUTOMATION_DISABLED：请先在独立启动器完成自己的授权并明确启用自动分析");
}

export function publicModelEnvironment(projectRoot: string): NodeJS.ProcessEnv {
  assertPublicAutomation();
  const allowed = ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];
  return { ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])), NODE_ENV: process.env.NODE_ENV ?? "production", CODEX_HOME: publicProfile(projectRoot, "model") };
}
