import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  fmt,
  formatBytes,
  formatDateTime,
  formatMoney,
  roundForDisplay,
  truncate,
} from "../src/lib/html";

describe("escapeHtml", () => {
  it("escapes all five HTML-special characters", () => {
    expect(escapeHtml(`<a href="x" data-y='&z'>`)).toBe(
      "&lt;a href=&quot;x&quot; data-y=&#39;&amp;z&#39;&gt;",
    );
  });

  it("coerces non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("null");
  });
});

describe("truncate", () => {
  it("keeps strings within the limit untouched", () => {
    expect(truncate("abcd", 4)).toBe("abcd");
  });

  it("shortens longer strings to maxLength ending in an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4)).toHaveLength(4);
  });
});

describe("fmt", () => {
  it("formats numbers to the requested digits and dashes out gaps", () => {
    expect(fmt(1.2345, 2)).toBe("1.23");
    expect(fmt(5)).toBe("5.0");
    expect(fmt(null)).toBe("-");
    expect(fmt(Number.NaN)).toBe("-");
  });
});

describe("formatMoney", () => {
  it("scales decimal places with magnitude", () => {
    expect(formatMoney(0.5)).toBe("$0.50");
    expect(formatMoney(12.34)).toBe("$12.3");
    expect(formatMoney(250.4)).toBe("$250");
    expect(formatMoney(null)).toBe("-");
  });

  it("uses locale grouping above $1000", () => {
    const expected = `$${(1234.5).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    expect(formatMoney(1234.5)).toBe(expected);
  });
});

describe("formatBytes", () => {
  it("picks B, KB, or MB units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(null)).toBe("-");
  });
});

describe("formatDateTime", () => {
  it("renders ISO timestamps as YYYY-MM-DD HH:MM:SS", () => {
    expect(formatDateTime("2026-06-12T03:04:05.678Z")).toBe("2026-06-12 03:04:05");
  });

  it("passes through unparseable values and dashes out empties", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime(null)).toBe("-");
  });
});

describe("roundForDisplay", () => {
  it("rounds to the displayed digits", () => {
    expect(roundForDisplay(1.2345, 2)).toBe(1.23);
    expect(roundForDisplay(1.2345, 0)).toBe(1);
  });

  it("clamps digits and tolerates non-finite values", () => {
    expect(roundForDisplay(1.5, -3)).toBe(2);
    expect(roundForDisplay(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });
});
