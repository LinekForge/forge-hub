import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ExecTextOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

interface SpawnTextOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function execFileText(
  command: string,
  args: string[],
  options: ExecTextOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: "utf-8",
  });
  return typeof stdout === "string" ? stdout : stdout.toString("utf-8");
}

export async function spawnText(
  command: string,
  args: string[],
  options: SpawnTextOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      fn();
    };

    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`process timeout after ${options.timeoutMs}ms`)));
      }, options.timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(() => resolve({ stdout, stderr }));
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `process exited (code=${code ?? "null"}, signal=${signal ?? "none"})`;
      finish(() => reject(new Error(detail)));
    });

    if (options.input != null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}
