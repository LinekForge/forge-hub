import fs from "node:fs";
import path from "node:path";

interface QueueAppendOptions {
  dirMode?: number;
  fileMode?: number;
  beforeAppend?: (content: string, filePath: string) => Promise<void> | void;
  afterAppend?: (bytes: number, filePath: string) => Promise<void> | void;
  onError?: (err: unknown, filePath: string) => void;
}

const fileQueues = new Map<string, Promise<void>>();
const inFlight = new Set<Promise<void>>();

export function enqueueAppend(filePath: string, content: string, options: QueueAppendOptions = {}): void {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const bytes = Buffer.byteLength(content);

  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
        mode: options.dirMode,
      });
      await options.beforeAppend?.(content, filePath);
      await fs.promises.appendFile(filePath, content, {
        encoding: "utf-8",
        mode: options.fileMode,
      });
      await options.afterAppend?.(bytes, filePath);
    })
    .catch((err) => {
      try {
        options.onError?.(err, filePath);
      } catch {}
    });

  fileQueues.set(filePath, next);
  inFlight.add(next);
  void next.finally(() => {
    inFlight.delete(next);
    if (fileQueues.get(filePath) === next) fileQueues.delete(filePath);
  });
}

export async function drainQueuedWrites(): Promise<void> {
  if (inFlight.size === 0) return;
  await Promise.allSettled([...inFlight]);
}
