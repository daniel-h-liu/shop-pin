import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { boxToRegion, cropImage, cropUrlFor, parseBox } from "@/lib/crop";
import { toBox } from "@/lib/vision/detectItems";

describe("item crops", () => {
  it("builds a crop URL only for Pinterest images on a public server", () => {
    const img = "https://i.pinimg.com/736x/ab/cd.jpg";
    expect(cropUrlFor(img, [100, 200, 500, 600], "https://shop.example")).toBe(
      `https://shop.example/api/crop?src=${encodeURIComponent(img)}&box=100%2C200%2C500%2C600`,
    );
    expect(cropUrlFor(img, [100, 200, 500, 600], undefined)).toBeUndefined(); // e.g. localhost
    expect(cropUrlFor("https://evil.example/a.jpg", [100, 200, 500, 600], "https://shop.example")).toBeUndefined();
    expect(cropUrlFor(img, undefined, "https://shop.example")).toBeUndefined();
  });

  it("parses and validates boxes", () => {
    expect(parseBox("100,200,500,600")).toEqual([100, 200, 500, 600]);
    expect(parseBox("500,200,100,600")).toBeUndefined();
    expect(parseBox("1,2,3")).toBeUndefined();
    expect(parseBox("0,0,1001,5")).toBeUndefined();
    expect(toBox([100.4, 200, 500, 600])).toEqual([100, 200, 500, 600]);
    expect(toBox([0, 0, 1000, 1000])).toBeUndefined(); // whole image
    expect(toBox([100, 100, 105, 400])).toBeUndefined(); // sliver
    expect(toBox(null)).toBeUndefined();
  });

  it("pads the box a little and stays inside the image", () => {
    expect(boxToRegion([0, 0, 500, 500], 1000, 2000)).toEqual({ left: 0, top: 0, width: 540, height: 1080 });
    const r = boxToRegion([900, 900, 1000, 1000], 100, 100);
    expect(r.left + r.width).toBeLessThanOrEqual(100);
    expect(r.top + r.height).toBeLessThanOrEqual(100);
  });

  it("crops a real image", async () => {
    const input = await sharp({ create: { width: 200, height: 400, channels: 3, background: "#7a1f2b" } }).png().toBuffer();
    const out = await cropImage(input, [250, 250, 750, 750]);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(116); // 100px + 8% padding each side
    expect(meta.height).toBe(232);
  });
});
