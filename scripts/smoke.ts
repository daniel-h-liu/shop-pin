/**
 * End-to-end smoke test: runs the vision + retailer pipeline over a hardcoded
 * set of sample image URLs, skipping Pinterest auth entirely.
 *
 * Requires GEMINI_API_KEY (and ideally SERPAPI_KEY) in .env.local.
 *
 *   npm run smoke
 */
import { readFileSync } from "fs";
import { pinsFromImageUrls } from "../lib/pinterest/fetchBoard";
import { createJob } from "../lib/pipeline/jobs";
import { runPipeline, searchItem } from "../lib/pipeline/orchestrator";

// Load .env.local without adding a dotenv dependency
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env.local — rely on the environment */
}

const SAMPLE_IMAGES = [
  // Stable, product-like sample images (Wikimedia Commons)
  "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Sneakers_%28unsplash%29.jpg/640px-Sneakers_%28unsplash%29.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/KitchenAid_5KSM150.jpg/640px-KitchenAid_5KSM150.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Eames_Lounge_Chair.jpg/640px-Eames_Lounge_Chair.jpg",
];

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set — add it to .env.local first.");
    process.exit(1);
  }
  if (!process.env.SERPAPI_KEY) {
    console.warn("SERPAPI_KEY not set — identification will run, but no retailer results will appear.");
  }

  const board = pinsFromImageUrls(SAMPLE_IMAGES);
  const job = createJob("smoke", board.pins.length, false);
  console.log(`Running pipeline over ${board.pins.length} sample images...\n`);

  const started = Date.now();
  await runPipeline(board.pins, job);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  for (const result of Object.values(job.results)) {
    console.log(`── ${result.pin.imageUrl}`);
    console.log(`   status: ${result.status}`);
    if (result.skipReason) console.log(`   skipped: ${result.skipReason}`);
    if (result.deferredReason) console.log(`   deferred: ${result.deferredReason}`);
    if (result.error) console.log(`   error: ${result.error}`);
    for (const item of result.items) {
      console.log(`   • ${item.productName} [${item.category}] query: "${item.searchQuery}"`);
    }
    // Only search the first item per pin to keep SerpApi spend low.
    const first = result.items[0];
    if (first) {
      const searched = await searchItem(job, result.pin.pinId, first.itemId);
      for (const deal of searched?.search.deals ?? []) {
        console.log(
          `     $${deal.price} — ${deal.retailer} — ${deal.title.slice(0, 60)} (match ${deal.matchConfidence.toFixed(2)})`,
        );
      }
      if (searched?.search.note) console.log(`     note: ${searched.search.note}`);
    }
    console.log();
  }
  console.log("usage:", JSON.stringify(job.usage));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
