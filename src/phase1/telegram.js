const fs = require("fs");
const { BOT_TOKEN, OUTPUT_JSON, TARGET_SELECTIONS } = require("./config");
const { scrapedCatalog, selectedDresses } = require("./state");
const { escapeHtml } = require("./utils");

let CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
let lastUpdateId = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

module.exports = { sendCatalogAndListen };
