export interface EngineAddTaskArgs {
  hour?: number;
  minute?: number;
  second?: number;
  delay_seconds?: number;
  template?: string;
  prompt: string;
  label?: string;
  sender?: string;
  one_shot?: boolean;
  weekdays?: number[];
  days?: number[];
  months?: number[];
  start_date?: string;
  end_date?: string;
}

export interface ResolvedTaskTiming {
  hour: number;
  minute: number;
  second: number;
  target?: Date;
  start_date?: string;
  end_date?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function resolveTaskTiming(
  args: EngineAddTaskArgs,
  now: Date = new Date(),
): ResolvedTaskTiming {
  const oneShot = args.one_shot !== false;
  const target =
    args.delay_seconds !== undefined
      ? new Date(now.getTime() + args.delay_seconds * 1000)
      : undefined;

  const hour = target ? target.getHours() : (args.hour ?? 0);
  const minute = target ? target.getMinutes() : (args.minute ?? 0);
  const second = target ? target.getSeconds() : (args.second ?? 0);
  const targetDate = target ? formatDate(target) : undefined;

  return {
    hour,
    minute,
    second,
    target,
    start_date: args.start_date ?? targetDate,
    end_date: args.end_date ?? (target && oneShot ? targetDate : undefined),
  };
}
