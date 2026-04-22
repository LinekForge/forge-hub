import fs from "node:fs";
import path from "node:path";

export interface SelfTestHarnessResolution {
  path: string;
  tried: string[];
}

interface ResolveSelfTestHarnessPathOptions {
  repoRootOverride?: string;
  cwd?: string;
  scriptDir?: string;
}

const HARNESS_RELATIVE_PATH = path.join("hub-test-harness", "harness.ts");

export function resolveSelfTestHarnessPath(
  options: ResolveSelfTestHarnessPathOptions = {},
): SelfTestHarnessResolution {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const scriptDir = path.resolve(options.scriptDir ?? import.meta.dir);

  const candidates = options.repoRootOverride
    ? [path.resolve(options.repoRootOverride, HARNESS_RELATIVE_PATH)]
    : [
        path.resolve(scriptDir, "..", HARNESS_RELATIVE_PATH),
        path.resolve(cwd, HARNESS_RELATIVE_PATH),
      ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return { path: found ?? candidates[0], tried: candidates };
}
