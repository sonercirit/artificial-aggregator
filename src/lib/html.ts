/**
 * Escaping and formatting primitives shared by the server-side renderers.
 * Everything here is pure and layout-agnostic.
 */

/** Escape a value for HTML text content or attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function fmt(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

/** ISO timestamp rendered as "YYYY-MM-DD HH:MM:SS"; unparseable input passes through. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/** Round to the digits a formatter will show, so charts plot what tooltips say. */
export function roundForDisplay(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;

  const safeDigits = Math.min(100, Math.max(0, Math.floor(digits)));
  return Number(value.toFixed(safeDigits));
}
