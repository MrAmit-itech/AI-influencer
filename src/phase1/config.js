const path = require("path");
const { ROOT } = require("../config");

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const AFFILIATE_TAG = (process.env.AMAZON_AFFILIATE_TAG || "yourtag-21").trim();
if (!BOT_TOKEN) {
  console.error("? Missing TELEGRAM_BOT_TOKEN in your .env file!");
  process.exit(1);
}
const CATEGORIES = [
  { name: "Festive Anarkali & Kurta Sets", query: "women festive embroidered anarkali kurta set" },
  { name: "Pinterest Organza Floral Midi", query: "women floral organza midi dress aesthetic" },
  { name: "Wedding Lehenga & Sharara", query: "women festive wear sharara suit lehenga" },
  { name: "Cocktail Satin Party Gown", query: "women satin cocktail maxi party dress" },
  { name: "Boho Chikankari & Indo-Western", query: "women georgette chikankari fusion dress" },
];
const ITEMS_PER_CATEGORY = 5;
const TARGET_SELECTIONS = 5;
const OUTPUT_JSON = path.join(ROOT, "selected_dresses.json");

module.exports = { BOT_TOKEN, AFFILIATE_TAG, CATEGORIES, ITEMS_PER_CATEGORY, TARGET_SELECTIONS, OUTPUT_JSON };
