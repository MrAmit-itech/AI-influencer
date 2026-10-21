const fs = require("fs");
const path = require("path");
const { BOT_TOKEN, CHAT_ID } = require("./config");

let chatId = CHAT_ID;

async function tgApi(method, payload = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.description || `Telegram API error on ${method}`);
  return data.result;
}

async function ensureChatId() {
  if (!BOT_TOKEN) return null;
  if (chatId) return chatId;
  const updates = await tgApi("getUpdates", { offset: -5 }).catch(() => []);
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    const id = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
    if (id) {
      chatId = String(id);
      return chatId;
    }
  }
  return null;
}

async function sendFinalVideoToTelegram(videoPath, captionText) {
  const targetChatId = await ensureChatId();
  if (!BOT_TOKEN || !targetChatId) {
    console.log(
      'ℹ️ Telegram Chat ID not set. Open your finished Reel inside the "output" folder.',
    );
    return false;
  }
  console.log(
    "\n📲 Uploading finished 20-sec Reel & Affiliate Links to Telegram...",
  );
  const videoBuffer = fs.readFileSync(videoPath);
  const formData = new FormData();
  formData.append("chat_id", targetChatId);
  formData.append("caption", captionText.slice(0, 1024));
  formData.append(
    "video",
    new Blob([videoBuffer], { type: "video/mp4" }),
    path.basename(videoPath),
  );
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`,
    { method: "POST", body: formData },
  );
  const data = await res.json();
  if (!data.ok)
    throw new Error(`Telegram video upload failed: ${data.description}`);
  console.log("✅ Delivered 20-sec Reel to your Telegram Bot!");
  return true;
}

module.exports = { sendFinalVideoToTelegram };
