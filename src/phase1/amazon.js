const { chromium } = require("playwright");
const { AFFILIATE_TAG, CATEGORIES, ITEMS_PER_CATEGORY } = require("./config");
const { scrapedCatalog } = require("./state");
const { toHighResAmazonImage } = require("./utils");

async function scrapeAmazonCategories() {
  console.log('\n🚀 Launching Chrome to scrape 25 trending dresses on Amazon.in...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();
  const allScraped = [];
  const seenAsins = new Set();

  for (const category of CATEGORIES) {
    console.log(`\n🔍 Scraping Category: ${category.name}...`);
    const searchUrl = `https://www.amazon.in/s?k=${encodeURIComponent(category.query)}&s=exact-aware-popularity-rank`;

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('div[data-component-type="s-search-result"]', { timeout: 15000 });

      const items = await page.$$eval(
        'div[data-component-type="s-search-result"][data-asin]',
        (cards, catName) => {
          const results = [];
          for (const card of cards) {
            const asin = card.getAttribute('data-asin');
            if (!asin) continue;

            const imgEl = card.querySelector('img.s-image');
            const titleEl = card.querySelector('h2 span') || card.querySelector('img.s-image');
            const priceEl = card.querySelector('.a-price .a-offscreen');

            const rawImg = imgEl ? imgEl.getAttribute('src') : null;
            const title = titleEl ? (titleEl.textContent || titleEl.getAttribute('alt') || '').trim() : '';
            const price = priceEl ? priceEl.textContent.trim() : 'Check Amazon';

            if (rawImg && title && !rawImg.includes('data:image')) {
              results.push({
                asin,
                title,
                price,
                rawImg,
                category: catName,
              });
            }
          }
          return results;
        },
        category.name
      );

      let count = 0;
      for (const item of items) {
        if (count >= ITEMS_PER_CATEGORY) break;
        if (seenAsins.has(item.asin)) continue;
        seenAsins.add(item.asin);

        const dressObj = {
          id: `dress_${allScraped.length + 1}`,
          asin: item.asin,
          category: item.category,
          title: item.title.slice(0, 90),
          price: item.price,
          imageUrl: toHighResAmazonImage(item.rawImg),
          productUrl: `https://www.amazon.in/dp/${item.asin}?tag=${AFFILIATE_TAG}`,
        };

        scrapedCatalog.set(dressObj.id, dressObj);
        allScraped.push(dressObj);
        count++;
      }

      console.log(`   ✅ Found ${count} dresses in "${category.name}"`);
    } catch (err) {
      console.warn(`   ⚠️ Skipped category "${category.name}": ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\n🎉 Total scraped dresses: ${allScraped.length}`);
  return allScraped;
}

// ==========================================
// 4. SEND PHOTOS & LISTEN FOR 5 SELECTIONS
// ==========================================

module.exports = { scrapeAmazonCategories };
