const { scrapeAmazonCategories } = require("./amazon");
const { sendCatalogAndListen } = require("./telegram");

async function run() {
  try {
    const dresses = await scrapeAmazonCategories();
    if (!dresses.length) {
      console.error("? No dresses were scraped. Check your internet connection or Amazon window.");
      process.exit(1);
    }
    await sendCatalogAndListen(dresses);
  } catch (error) {
    console.error("? Phase 1 Error:", error.message);
    process.exit(1);
  }
}

module.exports = { run };
