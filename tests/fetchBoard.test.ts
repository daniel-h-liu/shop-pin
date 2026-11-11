import { describe, expect, it } from "vitest";
import { parseBoardUrl, pinsFromImageUrls } from "@/lib/pinterest/fetchBoard";

describe("parseBoardUrl", () => {
  it("extracts username and board slug from a board URL", () => {
    expect(parseBoardUrl("https://www.pinterest.com/janedoe/cozy-fall-outfits/")).toEqual({
      username: "janedoe",
      slug: "cozy-fall-outfits",
    });
  });

  it("returns null for a non-Pinterest URL", () => {
    expect(parseBoardUrl("https://example.com/janedoe/cozy-fall-outfits/")).toBeNull();
  });

  it("returns null for a Pinterest URL without a board path", () => {
    expect(parseBoardUrl("https://www.pinterest.com/janedoe/")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(parseBoardUrl("not a url")).toBeNull();
  });
});

describe("pinsFromImageUrls", () => {
  it("de-duplicates and caps at MAX_PINS, flagging truncation", () => {
    const urls = Array.from({ length: 55 }, (_, i) => `https://img.example/${i}.jpg`);
    const result = pinsFromImageUrls([...urls, urls[0]]); // + one duplicate

    expect(result.source).toBe("fallback");
    expect(result.truncated).toBe(true);
    expect(result.pins).toHaveLength(50);
  });

  it("is not truncated when under the cap", () => {
    const result = pinsFromImageUrls(["https://img.example/1.jpg", "https://img.example/2.jpg"]);
    expect(result.truncated).toBe(false);
    expect(result.pins).toHaveLength(2);
  });
});
