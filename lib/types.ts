export type Pin = {
  pinId: string;
  imageUrl: string;
  title?: string;
  sourceLink?: string;
};

/** What retailer adapters search for. */
export type ProductID = {
  pinId: string;
  productName: string;
  category: string;
  brand?: string;
  attributes: string[];
  searchQuery: string;
  confidence: "high" | "medium" | "low";
};

/** One purchasable item detected in a pin (an outfit pin has several). */
export type DetectedItem = ProductID & {
  itemId: string;
  itemType: string; // "crewneck sweater"
  typeKeywords: string[]; // words a matching listing title should contain
  colors: string[];
  pattern: string; // "solid", "striped", ...
  /** Where the item sits in the pin photo: [ymin, xmin, ymax, xmax], 0-1000. */
  box?: [number, number, number, number];
  /** Public URL of the item cropped out of the pin (for Google Lens), when the server has one. */
  cropUrl?: string;
  search: ItemSearch;
};

export type RetailerListing = {
  retailer: string;
  title: string;
  price: number; // 0 = price not listed (only possible for `original`)
  currency: string;
  url: string;
  imageUrl?: string;
  matchConfidence: number; // 0-1
  matchReason?: string; // from the visual check
  exact?: boolean; // the visual check judged it to be the very same product
};

/** How each retailer responded to one item search. */
export type AdapterOutcome = {
  adapter: string;
  ok: boolean;
  count: number;
  cached?: boolean;
  message?: string; // UI-safe error description when !ok
};

export type ItemSearch = {
  /** "checking" = first results are in, the visual check is still running */
  status: "idle" | "searching" | "checking" | "done" | "error";
  /** The exact piece, when found: shown first at any price (may have no price). */
  original?: RetailerListing;
  /** Similar pieces, cheapest first (cheaper than `original` when it has a price). */
  deals: RetailerListing[];
  verified?: boolean; // deals passed Gemini's visual check
  note?: string; // why deals is empty / caveats, in plain English
  sources?: AdapterOutcome[];
};

export type PinStatus =
  | "pending"
  | "identifying"
  | "done"
  | "skipped"
  | "deferred" // not processed because a quota ran out; can be rerun
  | "error";

export type PinResult = {
  pin: Pin;
  status: PinStatus;
  confidence?: ProductID["confidence"];
  items: DetectedItem[];
  skipReason?: string;
  deferredReason?: string;
  error?: string;
};

export type Usage = {
  geminiIdentify: number; // item-detection requests sent to Gemini
  geminiVerify: number; // visual-check requests sent to Gemini
  geminiRateLimitWaits: number; // times we backed off on a per-minute limit
  retailerCalls: Record<string, number>; // adapter name -> real API calls
  cacheHits: number; // lookups answered from cache (no API spend)
};

export const emptyUsage = (): Usage => ({
  geminiIdentify: 0,
  geminiVerify: 0,
  geminiRateLimitWaits: 0,
  retailerCalls: {},
  cacheHits: 0,
});

export type JobHalt = {
  service: string;
  message: string;
  retryAt?: number; // epoch ms when rerunning should work
};

export type JobState = {
  jobId: string;
  createdAt: number;
  status: "running" | "done" | "error";
  totalPins: number;
  processedPins: number;
  truncated: boolean;
  boardName?: string;
  results: Record<string, PinResult>; // keyed by pinId
  usage: Usage;
  halt?: JobHalt;
  error?: string;
};
