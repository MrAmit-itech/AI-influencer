"use strict";

const fs = require("fs");
const path = require("path");

const { ROOT, CLIP_COUNT } = require("../config");
const { buildAffiliateUrl } = require("../products");

function loadSelectedProducts() {
  const selectedDressesPath = path.join(ROOT, "selected_dresses.json");

  if (!fs.existsSync(selectedDressesPath)) {
    throw new Error(
      "selected_dresses.json not found! Run phase1-scraper-bot.js first.",
    );
  }

  const products = JSON.parse(fs.readFileSync(selectedDressesPath, "utf8"));

  if (!Array.isArray(products) || products.length === 0) {
    throw new Error(
      "selected_dresses.json is empty or is not a valid product array.",
    );
  }

  return products;
}

function getSelectedProducts(products, videoMode, clipCountOverride = CLIP_COUNT) {
  return videoMode === "OPTION_B"
    ? products.slice(0, 1)
    : products.slice(0, clipCountOverride);
}

function buildAffiliateCaption(
  products,
  videoMode,
  affiliateTag,
  clipCountOverride = CLIP_COUNT,
) {
  const selectedProducts = getSelectedProducts(
    products,
    videoMode,
    clipCountOverride,
  );

  return selectedProducts.map((product, index) => {
    const productUrl = product.productUrl || product.url || product.link;
    const affiliateUrl = buildAffiliateUrl(
      productUrl,
      product.asin,
      affiliateTag,
    );

    if (videoMode === "OPTION_B") {
      return `👗 Featured Outfit (${product.price || ""}):\n${affiliateUrl}`;
    }

    return (
      `${index + 1}. ${(product.title || "Amazon Find").slice(0, 38)}... ` +
      `(${product.price || ""})\n${affiliateUrl}`
    );
  });
}

module.exports = {
  loadSelectedProducts,
  getSelectedProducts,
  buildAffiliateCaption,
};
