"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_VERSION_RAW = (
  process.env.INSTAGRAM_API_VERSION || "v25.0"
).trim();

const API_VERSION = API_VERSION_RAW.startsWith("v")
  ? API_VERSION_RAW
  : `v${API_VERSION_RAW}`;

const GRAPH_BASE = `https://graph.instagram.com/${API_VERSION}`;

const STATUS_POLL_MS = 60000;
const STATUS_TIMEOUT_MS = 8 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(
      `Missing ${name} in your project .env file.`
    );
  }

  return value;
}

async function readJsonResponse(response, label) {
  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(`${label}: server returned an invalid JSON response.`);
  }

  if (!response.ok || data.error) {
    const message =
      data.error?.message ||
      data.error?.error_user_msg ||
      `${label} failed with HTTP ${response.status}.`;

    throw new Error(`${label}: ${message}`);
  }

  return data;
}

// ---------- Cloudinary temporary video hosting ----------

function signCloudinaryParams(params, apiSecret) {
  const serialized = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(serialized + apiSecret)
    .digest("hex");
}

async function uploadVideoToCloudinary(videoPath) {
  const cloudName = requiredEnv("CLOUDINARY_CLOUD_NAME");
  const apiKey = requiredEnv("CLOUDINARY_API_KEY");
  const apiSecret = requiredEnv("CLOUDINARY_API_SECRET");

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Final Reel not found: ${videoPath}`);
  }

  const stat = fs.statSync(videoPath);

  if (!stat.isFile() || stat.size === 0) {
    throw new Error("The final Reel file is empty or invalid.");
  }

  const publicId =
    `instagram_reel_${Date.now()}_` +
    crypto.randomBytes(4).toString("hex");

  const timestamp = Math.floor(Date.now() / 1000);

  const signedParams = {
    public_id: publicId,
    timestamp: String(timestamp),
  };

  const signature = signCloudinaryParams(
    signedParams,
    apiSecret
  );

  const form = new FormData();

  form.append(
    "file",
    new Blob([fs.readFileSync(videoPath)], {
      type: "video/mp4",
    }),
    path.basename(videoPath)
  );

  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("signature", signature);

  console.log("☁️ Uploading final Reel to temporary video hosting...");

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await readJsonResponse(
    response,
    "Cloudinary video upload"
  );

  if (!data.secure_url || !data.public_id) {
    throw new Error(
      "Cloudinary did not return a secure video URL and public ID."
    );
  }

  console.log("✅ Temporary video hosting completed.");

  return {
    secureUrl: data.secure_url,
    publicId: data.public_id,
  };
}

async function deleteCloudinaryVideo(publicId) {
  try {
    const cloudName = requiredEnv("CLOUDINARY_CLOUD_NAME");
    const apiKey = requiredEnv("CLOUDINARY_API_KEY");
    const apiSecret = requiredEnv("CLOUDINARY_API_SECRET");

    const timestamp = Math.floor(Date.now() / 1000);

    const signedParams = {
      public_id: publicId,
      timestamp: String(timestamp),
    };

    const signature = signCloudinaryParams(
      signedParams,
      apiSecret
    );

    const form = new FormData();
    form.append("public_id", publicId);
    form.append("timestamp", String(timestamp));
    form.append("api_key", apiKey);
    form.append("signature", signature);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/video/destroy`,
      {
        method: "POST",
        body: form,
      }
    );

    const data = await response.json();

    if (!response.ok || data.result !== "ok") {
      throw new Error(
        data.error?.message || "Cloudinary did not confirm deletion."
      );
    }

    console.log("🧹 Removed temporary hosted Reel.");
  } catch (error) {
    // A temporary-host cleanup failure should not undo a successful post.
    console.warn(
      "⚠️ Could not remove temporary hosted video:",
      error.message
    );
  }
}

// ---------- Instagram publishing API ----------

async function instagramRequest(method, endpoint, params = {}) {
  const token = requiredEnv("INSTAGRAM_ACCESS_TOKEN");
  const url = new URL(`${GRAPH_BASE}${endpoint}`);

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };

  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  } else {
    options.headers["Content-Type"] =
      "application/x-www-form-urlencoded";

    options.body = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [
        key,
        String(value),
      ])
    ).toString();
  }

  const response = await fetch(url, options);

  return readJsonResponse(response, `Instagram API ${method} ${endpoint}`);
}

async function createReelContainer(igUserId, videoUrl, caption) {
  const shareToFeed = ![
    "false",
    "0",
    "no",
    "off",
  ].includes(
    String(process.env.INSTAGRAM_SHARE_TO_FEED || "true")
      .trim()
      .toLowerCase()
  );

  const result = await instagramRequest(
    "POST",
    `/${encodeURIComponent(igUserId)}/media`,
    {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      share_to_feed: shareToFeed,
    }
  );

  if (!result.id) {
    throw new Error("Instagram did not return a Reel container ID.");
  }

  console.log(`📦 Instagram Reel container created: ${result.id}`);

  return result.id;
}

async function waitForContainerReady(containerId) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await instagramRequest(
      "GET",
      `/${encodeURIComponent(containerId)}`,
      {
        fields: "status_code,status",
      }
    );

    const status = String(result.status_code || "").toUpperCase();

    console.log(
      `⏳ Instagram media processing: ${status || "WAITING"}`
    );

    if (status === "FINISHED") {
      return;
    }

    if (status === "ERROR" || status === "EXPIRED") {
      const error = new Error(
        `Instagram could not prepare the Reel: ${
          result.status || status
        }`
      );

      // The media processing reached a terminal state.
      error.terminalContainerStatus = true;
      throw error;
    }

    await sleep(STATUS_POLL_MS);
  }

  const error = new Error(
    "Timed out waiting for Instagram to finish processing the Reel. " +
    "The temporary video has been retained for troubleshooting."
  );

  error.processingTimedOut = true;
  throw error;
}

async function publishContainer(igUserId, containerId) {
  const result = await instagramRequest(
    "POST",
    `/${encodeURIComponent(igUserId)}/media_publish`,
    {
      creation_id: containerId,
    }
  );

  if (!result.id) {
    throw new Error(
      "Instagram did not return a published media ID."
    );
  }

  let permalink = null;

  try {
    const details = await instagramRequest(
      "GET",
      `/${encodeURIComponent(result.id)}`,
      {
        fields: "id,permalink",
      }
    );

    permalink = details.permalink || null;
  } catch (error) {
    console.warn(
      "⚠️ Reel was published, but its permalink could not be retrieved:",
      error.message
    );
  }

  return {
    mediaId: result.id,
    permalink,
  };
}

// ---------- Public entry point ----------

async function publishReel({ videoPath, caption }) {
  const igUserId = requiredEnv("INSTAGRAM_USER_ID");

  if (!caption || !String(caption).trim()) {
    throw new Error("Instagram caption is empty.");
  }

  if (String(caption).length > 2200) {
    throw new Error("Instagram caption exceeds 2200 characters.");
  }

  console.log("\n📤 Starting Instagram Reel publishing...");

  const hostedVideo = await uploadVideoToCloudinary(videoPath);

  let containerCreated = false;
  let safeToDeleteHostedVideo = false;

  try {
    let containerId;

    try {
      containerId = await createReelContainer(
        igUserId,
        hostedVideo.secureUrl,
        String(caption)
      );

      containerCreated = true;
    } catch (error) {
      // No successful container was returned, so Meta did not confirm
      // that it accepted this hosted URL for processing.
      safeToDeleteHostedVideo = true;
      throw error;
    }

    try {
      await waitForContainerReady(containerId);
      safeToDeleteHostedVideo = true;
    } catch (error) {
      if (error.terminalContainerStatus) {
        safeToDeleteHostedVideo = true;
      }

      // If processing times out, keep the URL alive because Meta may
      // still be fetching or processing the source video.
      throw error;
    }

    const published = await publishContainer(igUserId, containerId);

    console.log("\n========================================");
    console.log("🎉 INSTAGRAM REEL PUBLISHED SUCCESSFULLY");
    console.log(`🆔 Instagram media ID: ${published.mediaId}`);

    if (published.permalink) {
      console.log(`🔗 Reel URL: ${published.permalink}`);
    }

    console.log("========================================\n");

    return published;
  } finally {
    if (!containerCreated || safeToDeleteHostedVideo) {
      await deleteCloudinaryVideo(hostedVideo.publicId);
    } else {
      console.warn(
        "⚠️ Temporary hosted video retained because Instagram processing " +
        "did not reach a safe-to-delete state."
      );
      console.warn(`Cloudinary public ID: ${hostedVideo.publicId}`);
    }
  }
}

// ---------- Caption generation ----------

function buildInstagramCaption(category) {
  const key = String(category || "default")
    .trim()
    .toLowerCase();

  const captions = {
    ethnic: {
      hook: "A little ethnic-wear inspiration for your next look ✨",
      tags: "#IndianFashion #EthnicWear #EthnicStyle #FashionReels",
    },
    western: {
      hook: "Your next western-wear outfit inspiration ✨",
      tags: "#WesternWear #OutfitInspo #IndianFashion #FashionReels",
    },
    party: {
      hook: "Save this party-wear inspiration for later ✨",
      tags: "#PartyWear #PartyStyle #OutfitInspo #FashionReels",
    },
    casual: {
      hook: "Everyday outfit inspiration, made stylish ✨",
      tags: "#CasualWear #EverydayStyle #OutfitInspo #FashionReels",
    },
    coord: {
      hook: "Co-ord set inspiration for your wardrobe ✨",
      tags: "#CoOrdSet #CoOrdStyle #IndianFashion #FashionReels",
    },
    default: {
      hook: "A little outfit inspiration for your next look ✨",
      tags: "#IndianFashion #StyleInspo #OutfitInspiration #FashionReels",
    },
  };

  const selected = captions[key] || captions.default;

  return [
    selected.hook,
    "",
    "Save this look for outfit inspiration. Which style would you pick?",
    "",
    "AI-generated fashion creative. Check the seller's listing for exact product details.",
    "",
    "Affiliate disclosure: We may earn a commission from qualifying purchases through affiliate links, at no extra cost to you.",
    "",
    selected.tags,
  ].join("\n");
}

module.exports = {
  publishReel,
  buildInstagramCaption,
};