"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BOT_TOKEN, CHAT_ID } = require("./config");

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_TIMEOUT_SECONDS = 20;
const RETRY_DELAY_MS = 2000;

let chatId = CHAT_ID ? String(CHAT_ID) : null;
let initialUpdateOffset;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tgApi(method, payload = {}) {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const response = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    const error = new Error(
      data.description || `Telegram API error: ${method}`,
    );

    error.status = response.status;
    throw error;
  }

  return data.result;
}

async function ensureChatId() {
  if (chatId) return chatId;

  // Preserve auto-discovery for setups without a configured CHAT_ID.
  // Do not use a negative offset, which discards older queued updates.
  let updates;

  try {
    updates = await tgApi("getUpdates", { timeout: 0 });
  } catch (error) {
    console.warn("Could not discover Telegram chat ID:", error.message);
    return null;
  }

  if (updates.length > 0) {
    initialUpdateOffset =
      Math.max(...updates.map((update) => update.update_id)) + 1;
  }

  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];

    const id =
      update.message?.chat?.id || update.callback_query?.message?.chat?.id;

    if (id) {
      chatId = String(id);
      return chatId;
    }
  }

  return null;
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await tgApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (error) {
    console.warn("Could not acknowledge Telegram button:", error.message);
  }
}

async function sendApprovalVideo(
  videoPath,
  captionText,
  targetChatId,
  approvalId,
) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Final video not found: ${videoPath}`);
  }

  const stat = fs.statSync(videoPath);

  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Final video is empty or invalid: ${videoPath}`);
  }

  console.log("\n📲 Sending final Reel to Telegram for approval...");

  const formData = new FormData();
  formData.append("chat_id", String(targetChatId));
  formData.append("caption", String(captionText || "").slice(0, 1024));

  formData.append(
    "video",
    new Blob([fs.readFileSync(videoPath)], { type: "video/mp4" }),
    path.basename(videoPath),
  );

  formData.append(
    "reply_markup",
    JSON.stringify({
      inline_keyboard: [
        [
          {
            text: "✅ Confirm for Instagram",
            callback_data: `ap:${approvalId}:y`,
          },
          {
            text: "❌ Reject",
            callback_data: `ap:${approvalId}:n`,
          },
        ],
      ],
    }),
  );

  const response = await fetch(`${API_BASE}/sendVideo`, {
    method: "POST",
    body: formData,
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram video upload failed: ${
        data.description || response.statusText
      }`,
    );
  }

  console.log("✅ Final Reel delivered to Telegram.");
  console.log("⏳ Waiting for your confirmation...");

  return data.result;
}

async function waitForApproval(targetChatId, messageId, approvalId, videoPath) {
  let offset = initialUpdateOffset;

  while (true) {
    let updates;

    try {
      updates = await tgApi("getUpdates", {
        ...(offset === undefined ? {} : { offset }),
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["callback_query"],
      });
    } catch (error) {
      // Do not retry errors that require configuration changes.
      if (error.status === 409) {
        throw new Error(
          "Telegram polling conflict. Stop other processes polling " +
            "this bot token, then run Phase 2 again.",
        );
      }

      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw error;
      }

      console.warn("⚠️ Temporary Telegram polling error:", error.message);

      await sleep(RETRY_DELAY_MS);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;

      const query = update.callback_query;
      if (!query) continue;

      const expectedPrefix = `ap:${approvalId}:`;

      if (!String(query.data || "").startsWith(expectedPrefix)) {
        // Do not act on an old or unrelated approval button.
        await answerCallbackQuery(
          query.id,
          "This is not the active approval request.",
        );
        continue;
      }

      const callbackChatId = query.message?.chat?.id;
      const callbackMessageId = query.message?.message_id;

      if (
        String(callbackChatId) !== String(targetChatId) ||
        callbackMessageId !== messageId
      ) {
        await answerCallbackQuery(
          query.id,
          "This approval request is not active.",
        );
        continue;
      }

      const decision = query.data.slice(expectedPrefix.length);

      if (decision !== "y" && decision !== "n") {
        await answerCallbackQuery(query.id, "Invalid selection.");
        continue;
      }

      await answerCallbackQuery(
        query.id,
        decision === "y" ? "Video confirmed!" : "Video rejected.",
      );

      try {
        await tgApi("editMessageReplyMarkup", {
          chat_id: targetChatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) {
        console.warn("Could not remove approval buttons:", error.message);
      }

      if (decision === "y") {
        console.log("\n========================================");
        console.log("✅ USER CONFIRMED THE REEL");
        console.log("📌 STATUS: READY FOR POSTING ON INSTAGRAM");
        console.log(`🎬 VIDEO: ${path.basename(videoPath)}`);
        console.log("ℹ️ Instagram has NOT been posted automatically.");
        console.log("========================================\n");

        return "confirmed";
      }

      console.log("\n========================================");
      console.log("❌ USER REJECTED THE REEL");
      console.log("📌 STATUS: REJECTED — NOT READY FOR POSTING");
      console.log(`🎬 VIDEO: ${path.basename(videoPath)}`);
      console.log("ℹ️ No Instagram post or DM was sent.");
      console.log("========================================\n");

      return "rejected";
    }
  }
}

async function sendFinalVideoForApproval(videoPath, captionText) {
  if (!BOT_TOKEN) {
    console.log("ℹ️ Telegram bot token is not configured.");
    return false;
  }

  const targetChatId = await ensureChatId();

  if (!targetChatId) {
    console.log(
      "ℹ️ Telegram Chat ID not found. Configure CHAT_ID or send " +
        "a message to your bot before running Phase 2.",
    );
    return false;
  }

  const approvalId = crypto.randomBytes(6).toString("hex");

  const sentMessage = await sendApprovalVideo(
    videoPath,
    captionText,
    targetChatId,
    approvalId,
  );

  const decision = await waitForApproval(
    targetChatId,
    sentMessage.message_id,
    approvalId,
    videoPath,
  );

  return decision; // "confirmed" or "rejected"
}

module.exports = {
  sendFinalVideoForApproval,
};
