const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const { chromium } = require('playwright');

// ==========================================
// 1. CONFIGURATION & CATEGORIES
// ==========================================
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
let CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const AFFILIATE_TAG = (process.env.AMAZON_AFFILIATE_TAG || 'yourtag-21').trim();

if (!BOT_TOKEN) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN in your .env file!');
  process.exit(1);
}

// 5 Trending Pinterest / Festive Dress Categories on Amazon.in (5 picks each = 25 total)
const CATEGORIES = [
  { name: 'Festive Anarkali & Kurta Sets', query: 'women festive embroidered anarkali kurta set' },
  { name: 'Pinterest Organza Floral Midi', query: 'women floral organza midi dress aesthetic' },
  { name: 'Wedding Lehenga & Sharara', query: 'women festive wear sharara suit lehenga' },
  { name: 'Cocktail Satin Party Gown', query: 'women satin cocktail maxi party dress' },
  { name: 'Boho Chikankari & Indo-Western', query: 'women georgette chikankari fusion dress' },
];

const ITEMS_PER_CATEGORY = 5;
const TARGET_SELECTIONS = 5;
const OUTPUT_JSON = path.join(__dirname, 'selected_dresses.json');

const scrapedCatalog = new Map();
const selectedDresses = [];
let lastUpdateId = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escape special characters in Amazon titles so Telegram captions never fail
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Upgrade Amazon thumbnail URL to 1200p high-res image for Gemini Vision & Google Flow
function toHighResAmazonImage(url) {
  if (!url) return '';
  return url.replace(/\._[A-Z0-9,_-]+_\.(jpg|png|webp)$/i, '._SL1200_.$1');
}

// ==========================================
// 2. NATIVE TELEGRAM API HELPER (NO LIBRARY NEEDED)
// ==========================================
async function tgApi(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error on ${method}`);
  }
  return data.result;
}

async function ensureChatId() {
  // Clear any active webhook so getUpdates polling works cleanly
  await tgApi('deleteWebhook').catch(() => {});

  if (CHAT_ID) return CHAT_ID;

  console.log('\n📲 TELEGRAM_CHAT_ID is blank in your .env file.');
  console.log('👉 Open your Telegram bot right now and send "hi" to auto-detect your Chat ID...');

  while (!CHAT_ID) {
    const updates = await tgApi('getUpdates', { offset: lastUpdateId + 1, timeout: 20 });
    for (const u of updates) {
      lastUpdateId = u.update_id;
      const chat = u.message?.chat || u.callback_query?.message?.chat;
      if (chat?.id) {
        CHAT_ID = String(chat.id);
        console.log(`✅ Detected your Telegram Chat ID: ${CHAT_ID}`);
        console.log(`💡 Tip: Add TELEGRAM_CHAT_ID=${CHAT_ID} to your .env file for next time!`);
        break;
      }
    }
  }
  return CHAT_ID;
}

// ==========================================
// 3. AMAZON.IN PLAYWRIGHT SCRAPER
// ==========================================
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
async function sendCatalogAndListen(dresses) {
  await ensureChatId();

  // Flush any old button clicks before starting
  const oldUpdates = await tgApi('getUpdates', { offset: -1 }).catch(() => []);
  if (oldUpdates.length) {
    lastUpdateId = oldUpdates[oldUpdates.length - 1].update_id;
  }

  await tgApi('sendMessage', {
    chat_id: CHAT_ID,
    text: `👗 <b>AI Influencer Catalog Ready!</b>\nScraped <b>${dresses.length} trending Amazon.in dresses</b> across 5 categories.\n\n👇 Tap <b>"Select ✅"</b> on your <b>${TARGET_SELECTIONS} favorite outfits</b> below:`,
    parse_mode: 'HTML',
  });

  console.log(`\n📤 Sending ${dresses.length} dress photos to your Telegram Bot...`);

  for (let i = 0; i < dresses.length; i++) {
    const d = dresses[i];
    const caption = `<b>#${i + 1} [${escapeHtml(d.category)}]</b>\n${escapeHtml(d.title)}\n💰 <b>Price:</b> ${escapeHtml(d.price)}`;

    try {
      await tgApi('sendPhoto', {
        chat_id: CHAT_ID,
        photo: d.imageUrl,
        caption,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Select ✅', callback_data: `select:${d.id}` },
              { text: 'View on Amazon 🔗', url: d.productUrl },
            ],
          ],
        },
      });
      await sleep(350); // Avoid Telegram rate limit
    } catch (err) {
      console.warn(`   ⚠️ Could not send photo #${i + 1}: ${err.message}`);
    }
  }

  console.log(`\n⏳ Waiting for you to tap "Select ✅" on ${TARGET_SELECTIONS} dresses in Telegram...`);

  // Poll for your 5 "Select ✅" button taps
  while (selectedDresses.length < TARGET_SELECTIONS) {
    const updates = await tgApi('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 25,
    }).catch(() => []);

    for (const update of updates) {
      lastUpdateId = update.update_id;
      const query = update.callback_query;
      if (!query || !query.data?.startsWith('select:')) continue;

      const dressId = query.data.replace('select:', '');
      const dress = scrapedCatalog.get(dressId);

      if (!dress) {
        await tgApi('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Dress not found in current session.',
        }).catch(() => {});
        continue;
      }

      if (selectedDresses.some((d) => d.id === dress.id)) {
        await tgApi('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Already selected!',
        }).catch(() => {});
        continue;
      }

      selectedDresses.push(dress);
      const currentCount = selectedDresses.length;
      console.log(`✅ Selected [${currentCount}/${TARGET_SELECTIONS}]: ${dress.title.slice(0, 50)}...`);

      // Update button text on Telegram message
      await tgApi('editMessageReplyMarkup', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              { text: `Selected 🌟 (${currentCount}/${TARGET_SELECTIONS})`, callback_data: 'noop' },
              { text: 'View on Amazon 🔗', url: dress.productUrl },
            ],
          ],
        },
      }).catch(() => {});

      await tgApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: `Saved pick ${currentCount} of ${TARGET_SELECTIONS}!`,
      }).catch(() => {});

      if (currentCount >= TARGET_SELECTIONS) break;
    }
  }

  // Save the 5 picks to selected_dresses.json
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(selectedDresses, null, 2), 'utf8');
  console.log(`\n🎉 All ${TARGET_SELECTIONS} dresses saved to: ${OUTPUT_JSON}`);

  await tgApi('sendMessage', {
    chat_id: CHAT_ID,
    text: `🎉 <b>All ${TARGET_SELECTIONS} Dresses Locked In!</b>\nSaved to <code>selected_dresses.json</code> in VS Code.\n\n👉 Now run <code>node phase2-flow-generator.js</code> in your VS Code terminal!`,
    parse_mode: 'HTML',
  });

  process.exit(0);
}

// ==========================================
// 5. RUN PHASE 1
// ==========================================
(async () => {
  try {
    const dresses = await scrapeAmazonCategories();
    if (!dresses.length) {
      console.error('❌ No dresses were scraped. Check your internet connection or Amazon window.');
      process.exit(1);
    }
    await sendCatalogAndListen(dresses);
  } catch (err) {
    console.error('❌ Phase 1 Error:', err.message);
    process.exit(1);
  }
})();