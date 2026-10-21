const path = require("path");
const { ROOT } = require("../config");
const fs = require("fs");

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const CHARACTER_IMAGE_RAW = (process.env.CHARACTER_IMAGE_PATH || "character_reference.png").trim();
const CHARACTER_IMAGE_PATH = path.isAbsolute(CHARACTER_IMAGE_RAW)
  ? CHARACTER_IMAGE_RAW
  : path.resolve(ROOT, CHARACTER_IMAGE_RAW);
const DEFAULT_AFFILIATE_TAG = (process.env.AMAZON_AFFILIATE_TAG || "yourtag-21").trim();
const FLOW_URL = "https://labs.google/fx/tools/flow";
const CLIP_COUNT = Number(process.env.CLIP_COUNT || 5);
if (!Number.isInteger(CLIP_COUNT) || CLIP_COUNT < 1) {
  throw new Error("CLIP_COUNT in .env must be a positive whole number.");
}
if (!GEMINI_API_KEY) {
  console.error("? Missing GEMINI_API_KEY in your .env file!");
  process.exit(1);
}
const DIRS = {
  tempImages: path.join(ROOT, "temp_images"),
  clips: path.join(ROOT, "clips"),
  output: path.join(ROOT, "output"),
  profile: path.join(ROOT, ".bot-profile"),
};
Object.values(DIRS).forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
const FLOW_GENERATION_TIMEOUT_MS = Math.max(60000, Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 240000));
const FLOW_DOWNLOAD_TIMEOUT_MS = Math.max(10000, Number(process.env.FLOW_DOWNLOAD_TIMEOUT_MS || 45000));

module.exports = { ROOT, BOT_TOKEN, CHAT_ID, GEMINI_API_KEY, CHARACTER_IMAGE_PATH, DEFAULT_AFFILIATE_TAG, FLOW_URL, DIRS, CLIP_COUNT, FLOW_GENERATION_TIMEOUT_MS, FLOW_DOWNLOAD_TIMEOUT_MS };
