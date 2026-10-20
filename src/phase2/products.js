const fs = require("fs");

async function downloadImage(url, destPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!response.ok)
    throw new Error(
      `Failed to download dress image (${response.status}): ${url}`,
    );
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
}

function buildAffiliateUrl(rawUrl, asin, affiliateTag) {
  if (asin) return `https://www.amazon.in/dp/${asin}?tag=${affiliateTag}`;
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set("tag", affiliateTag);
    return parsed.toString();
  } catch {
    return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}tag=${affiliateTag}`;
  }
}

module.exports = { downloadImage, buildAffiliateUrl };
