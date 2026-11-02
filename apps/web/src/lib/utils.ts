import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function human(value: string) { return value.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase()); }
export function date(value?: string | null, time = false, language: "en" | "hi" = "en") {
  if (!value) return language === "hi" ? "दर्ज नहीं" : "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return language === "hi" ? "दर्ज नहीं" : "Not recorded";
  return new Intl.DateTimeFormat(language === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short", ...(time ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }) }).format(parsed);
}
export function initials(value: string) { return value.split(" ").filter(Boolean).slice(0, 2).map(s => s[0]).join("").toUpperCase(); }
