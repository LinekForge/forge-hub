/**
 * 模板引擎 — {key} 变量替换
 */

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export interface TemplateVars {
  time: string;
  date: string;
  weekday: string;
  label: string;
  prompt: string;
  contacts: string;
  [key: string]: string;
}

export function buildTimeVars(): Pick<TemplateVars, "time" | "date" | "weekday"> {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const weekday = `星期${WEEKDAY_NAMES[now.getDay()]}`;
  return { time, date, weekday };
}

export function renderTemplate(
  template: string,
  vars: Partial<TemplateVars>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}
