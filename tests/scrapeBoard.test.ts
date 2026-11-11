import { describe, expect, it, vi } from "vitest";
import {
  BoardScrapeError,
  normalizeRawPin,
  parseBoardRss,
  scrapePublicBoard,
} from "@/lib/pinterest/scrapeBoard";
import { parseBoardUrl } from "@/lib/pinterest/fetchBoard";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const rawPin = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "pin",
  id,
  title: `Pin ${id}`,
  link: `https://shop.example/${id}`,
  images: {
    "236x": { url: `https://i.pinimg.com/236x/${id}.jpg` },
    "736x": { url: `https://i.pinimg.com/736x/${id}.jpg` },
    orig: { url: `https://i.pinimg.com/originals/${id}.jpg` },
  },
  ...extra,
});

function mockFetch(handlers: {
  board?: () => Response;
  feed?: () => Response;
  rss?: () => Response;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.includes("BoardResource")) return handlers.board?.() ?? json({}, 500);
    if (url.pathname.includes("BoardFeedResource")) {
      
      return handlers.feed?.() ?? json({}, 500);
    }
    if (url.pathname.endsWith(".rss")) return handlers.rss?.() ?? new Response("", { status: 500 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

const boardOk = (pinCount: number) => () =>
  json({ resource_response: { data: { id: "B1", name: "NYC Style", pin_count: pinCount, privacy: "public" } } });

describe("parseBoardUrl", () => {
  it("rejects single-pin and search URLs", () => {
    expect(parseBoardUrl("https://www.pinterest.com/pin/12345/")).toBeNull();
    expect(parseBoardUrl("https://www.pinterest.com/search/pins/?q=x")).toBeNull();
  });
  it("accepts regional domains and section URLs", () => {
    expect(parseBoardUrl("https://uk.pinterest.co.uk/jane/decor/living-room/")).toEqual({
      username: "jane",
      slug: "decor",
    });
  });
});

describe("normalizeRawPin", () => {
  it("prefers the 736x image and keeps title/link", () => {
    expect(normalizeRawPin(rawPin("a"))).toEqual({
      pinId: "a",
      imageUrl: "https://i.pinimg.com/736x/a.jpg",
      title: "Pin a",
      sourceLink: "https://shop.example/a",
    });
  });
  it("drops non-pin feed items and pins without images", () => {
    expect(normalizeRawPin({ type: "story", id: "s" })).toBeNull();
    expect(normalizeRawPin({ type: "pin", id: "x" })).toBeNull();
  });
});

describe("parseBoardRss", () => {
  it("extracts pins and upgrades thumbnails to 736x", () => {
    const xml = `<rss><channel><item>
      <title>Cute lamp &amp; shade</title>
      <link>https://www.pinterest.com/pin/abc123/</link>
      <description>&lt;a href=&quot;x&quot;&gt;&lt;img src=&quot;https://i.pinimg.com/236x/60/28/lamp.jpg&quot;&gt;&lt;/a&gt;Cute lamp</description>
    </item></channel></rss>`;
    expect(parseBoardRss(xml)).toEqual([
      { pinId: "abc123", imageUrl: "https://i.pinimg.com/736x/60/28/lamp.jpg", title: "Cute lamp & shade" },
    ]);
  });
});

describe("scrapePublicBoard", () => {
  const url = "https://www.pinterest.com/jane/decor/";

  it("scrapes pins, skips stories, and caps at maxPins with truncation", async () => {
    const fetchImpl = mockFetch({
      board: boardOk(80),
      feed: () =>
        json({
          resource_response: {
            data: [rawPin("1"), { type: "story", id: "s1" }, rawPin("2"), rawPin("3")],
            bookmark: "-end-",
          },
        }),
    });
    const res = await scrapePublicBoard(url, { maxPins: 2, fetchImpl });
    expect(res.source).toBe("scrape");
    expect(res.boardName).toBe("NYC Style");
    expect(res.pins.map((p) => p.pinId)).toEqual(["1", "2"]);
    expect(res.truncated).toBe(true);
  });

  it("retries a short feed response and keeps the fullest one, de-duplicated", async () => {
    let calls = 0;
    const fetchImpl = mockFetch({
      board: boardOk(3),
      feed: () =>
        ++calls === 1
          ? json({ resource_response: { data: [rawPin("1")] } })
          : json({ resource_response: { data: [rawPin("1"), rawPin("2"), rawPin("2"), rawPin("3")] } }),
    });
    const res = await scrapePublicBoard(url, { fetchImpl });
    expect(calls).toBe(2);
    expect(res.pins.map((p) => p.pinId)).toEqual(["1", "2", "3"]);
    expect(res.truncated).toBe(false);
  });

  it("reports missing/private boards without trying RSS", async () => {
    const fetchImpl = mockFetch({ board: () => json({ resource_response: { data: null } }, 403) });
    await expect(scrapePublicBoard(url, { fetchImpl })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("falls back to RSS when the resource API is blocked", async () => {
    const fetchImpl = mockFetch({
      board: () => new Response("<html>blocked</html>", { status: 429 }),
      rss: () =>
        new Response(
          `<rss><item><title>T</title><link>https://www.pinterest.com/pin/r1/</link><description>&lt;img src=&quot;https://i.pinimg.com/236x/r1.jpg&quot;&gt;</description></item></rss>`,
        ),
    });
    const res = await scrapePublicBoard(url, { fetchImpl });
    expect(res.pins).toEqual([{ pinId: "r1", imageUrl: "https://i.pinimg.com/736x/r1.jpg", title: "T" }]);
  });

  it("rejects non-board URLs", async () => {
    await expect(
      scrapePublicBoard("https://example.com/foo/bar", { fetchImpl: mockFetch({}) }),
    ).rejects.toBeInstanceOf(BoardScrapeError);
  });
});
