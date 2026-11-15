import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBeehiveOrigin } from "./origin";

afterEach(() => vi.restoreAllMocks());

describe("parseBeehiveOrigin", () => {
  it("is off for an empty value, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseBeehiveOrigin("", false)).toBeUndefined();
    expect(parseBeehiveOrigin(undefined, false)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
  it("takes an https origin and drops a trailing slash", () => {
    expect(parseBeehiveOrigin("https://hive.example.org/", false)).toBe(
      "https://hive.example.org",
    );
  });
  it("takes local http only in development", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseBeehiveOrigin("http://localhost:3100", true)).toBe(
      "http://localhost:3100",
    );
    expect(parseBeehiveOrigin("http://127.0.0.1:3100", true)).toBe(
      "http://127.0.0.1:3100",
    );
    expect(parseBeehiveOrigin("http://localhost:3100", false)).toBeUndefined();
  });
  it.each([
    "http://hive.example.org",
    "https://hive.example.org/api",
    "https://hive.example.org/?a=1",
    "https://hive.example.org/#x",
    "https://user:pw@hive.example.org",
    "not a url",
    "ftp://hive.example.org",
  ])("refuses %s with a warning", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseBeehiveOrigin(value, true)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
