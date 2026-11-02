import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function human(value: string) { return value.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase()); }
export function date(value?: string | null, time = false) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(time ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }) }).format(parsed);
}
export function initials(value: string) { return value.split(" ").filter(Boolean).slice(0, 2).map(s => s[0]).join("").toUpperCase(); }
