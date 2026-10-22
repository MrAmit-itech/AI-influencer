
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} is missing from your project .env file.`);
  }

  return value;
}

async function readJson(response, label) {
  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(`${label}: received an invalid JSON response.`);
  }

  if (!response.ok || data.error) {
    const error = new Error(
      data.error?.message ||
      `${label}: HTTP ${response.status}`
    );

    error.httpStatus = response.status;
    throw error;
  }

  return data;
}

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

function findFinalVideo() {
  const suppliedPath = process.argv[2];

  if (suppliedPath) {
    return path.resolve(__dirname, suppliedPath);
  }

  // Use the most recently modified MP4 in output/.
  const outputDir = path.join(__dirname, "output");

  if (!fs.existsSync(outputDir)) {
    throw new Error(
      'No output/ folder found. Run Phase 2 with ' +
      "CLEANUP_AFTER_DELIVERY=false to preserve the final Reel."
    );
  }

  const videos = fs
    .readdirSync(outputDir)
    .filter((name) => name.toLowerCase().endsWith(".mp4"))
    .map((name) => {
      const fullPath = path.join(outputDir, name);
      const stat = fs.statSync(fullPath);

      return {
        fullPath,
        modified: stat.mtimeMs,
        size: stat.size,
      };
    })
    .filter((file) => file.size > 0)
    .sort((a, b) => b.modified - a.modified);

  if (!videos.length) {
    throw new Error(
      "No final MP4 found in output/. Set " +
      "CLEANUP_AFTER_DELIVERY=false in .env, generate the Reel again, " +
      "and then retry this test."
    );
  }

  return videos[0].fullPath;
}

async function uploadToCloudinary(videoPath, credentials) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const publicId =
    `instagram_preflight_${Date.now()}_` +
    crypto.randomBytes(3).toString("hex");

  const params = {
    public_id: publicId,
    timestamp,
  };

  const signature = signCloudinaryParams(
    params,
    credentials.apiSecret
  );

  const form = new FormData();

  form.append(
    "file",
    new Blob([fs.readFileSync(videoPath)], {
      type: "video/mp4",
    }),
    path.basename(videoPath)
  );

  form.append("api_key", credentials.apiKey);
  form.append("public_id", publicId);
  form.append("timestamp", timestamp);
  form.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      credentials.cloudName
    )}/video/upload`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await readJson(response, "Cloudinary upload");

  if (!data.secure_url || !data.public_id) {
    throw new Error("Cloudinary did not return a usable video URL.");
  }

  return {
    secureUrl: data.secure_url,
    publicId: data.public_id,
  };
}

async function verifyPublicUrl(url) {
  const response = await fetch(url, { method: "HEAD" });
  return response.ok;
}

async function instagramRequest(method, endpoint, params = {}) {
  const token = requiredEnv("INSTAGRAM_ACCESS_TOKEN");
  const rawVersion = String(
    process.env.INSTAGRAM_API_VERSION || "v25.0"
  ).trim();

  const version = rawVersion.startsWith("v")
    ? rawVersion
    : `v${rawVersion}`;

  const url = new URL(
    `https://graph.instagram.com/${version}${endpoint}`
  );

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

  return readJson(response, `Instagram API ${method}`);
}

async function createReelContainer(igUserId, videoUrl) {
  console.log("📦 Requesting an Instagram Reel container...");

  const result = await instagramRequest(
    "POST",
    `/${encodeURIComponent(igUserId)}/media`,
    {
      media_type: "REELS",
      video_url: videoUrl,
      caption:
        "Private integration preflight test. " +
        "This container will not be published by this script.",
      share_to_feed: "false",
    }
  );

  if (!result.id) {
    throw new Error(
      "Instagram did not return a media container ID."
    );
  }

  console.log("✅ Instagram accepted the container request.");
  console.log(`🆔 Container ID: ${result.id}`);

  return result.id;
}

async function waitUntilReady(containerId) {
  // Five checks, spaced one minute apart.
  // Never call /media_publish from this test.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    console.log(
      `🔎 Checking processing status (${attempt}/5)...`
    );

    const status = await instagramRequest(
      "GET",
      `/${encodeURIComponent(containerId)}`,
      { fields: "status_code,status" }
    );

    const code = String(status.status_code || "").toUpperCase();

    console.log(
      `📍 Status: ${code || "UNKNOWN"}` +
      (status.status ? ` — ${status.status}` : "")
    );

    if (code === "FINISHED") {
      return { ready: true, status };
    }

    if (code === "ERROR" || code === "EXPIRED") {
      const error = new Error(
        `Instagram processing ended with ${code}: ` +
        `${status.status || "No additional details"}`
      );

      error.terminalStatus = true;
      throw error;
    }

    if (code !== "IN_PROGRESS") {
      throw new Error(
        `Unexpected Instagram container status: ${code || "missing"}`
      );
    }

    if (attempt < 5) {
      console.log("⏳ Waiting 60 seconds before the next check...");
      await sleep(60_000);
    }
  }

  const error = new Error(
    "Instagram is still processing after five checks. " +
    "The hosted video will be retained for troubleshooting."
  );

  error.processingTimeout = true;
  throw error;
}

async function deleteCloudinaryVideo(publicId, credentials) {
  const timestamp = String(Math.floor(Date.now() / 1000));

  const params = {
    public_id: publicId,
    timestamp,
  };

  const signature = signCloudinaryParams(
    params,
    credentials.apiSecret
  );

  const form = new FormData();

  form.append("public_id", publicId);
  form.append("timestamp", timestamp);
  form.append("api_key", credentials.apiKey);
  form.append("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      credentials.cloudName
    )}/video/destroy`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await readJson(response, "Cloudinary cleanup");

  if (data.result !== "ok" && data.result !== "not found") {
    throw new Error(
      `Unexpected Cloudinary deletion result: ${data.result}`
    );
  }

  console.log("🧹 Temporary Cloudinary video removed.");
}

async function main() {
  const token = requiredEnv("INSTAGRAM_ACCESS_TOKEN");
  const igUserId = requiredEnv("INSTAGRAM_USER_ID");

  // Fail early if required configuration is incomplete.
  if (!token || !igUserId) {
    throw new Error("Instagram token or user ID is missing.");
  }

  const credentials = {
    cloudName: requiredEnv("CLOUDINARY_CLOUD_NAME"),
    apiKey: requiredEnv("CLOUDINARY_API_KEY"),
    apiSecret: requiredEnv("CLOUDINARY_API_SECRET"),
  };

  const videoPath = findFinalVideo();
  const stat = fs.statSync(videoPath);

  if (!stat.isFile() || stat.size === 0) {
    throw new Error("Final Reel file is empty or invalid.");
  }

  console.log("🔎 Starting Instagram container preflight.");
  console.log(`🎬 Video: ${path.relative(__dirname, videoPath)}`);
  console.log(`📦 Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  let hostedVideo = null;
  let safeToDeleteHostedVideo = false;

  try {
    hostedVideo = await uploadToCloudinary(videoPath, credentials);

    console.log("☁️ Cloudinary upload succeeded.");

    const urlReachable = await verifyPublicUrl(hostedVideo.secureUrl);

    if (!urlReachable) {
      safeToDeleteHostedVideo = true;
      throw new Error("The hosted video URL is not publicly reachable.");
    }

    let containerId;

    try {
      containerId = await createReelContainer(
        igUserId,
        hostedVideo.secureUrl
      );
    } catch (error) {
      // Keep the URL when the request outcome is ambiguous, such as
      // a network error after submission. If Meta explicitly rejected
      // the request with a client error, it is safe to remove the asset.
      if (error.httpStatus && error.httpStatus < 500) {
        safeToDeleteHostedVideo = true;
      }

      throw error;
    }

    try {
      const result = await waitUntilReady(containerId);

      if (result.ready) {
        safeToDeleteHostedVideo = true;

        console.log("\n========================================");
        console.log("✅ INSTAGRAM CONTAINER TEST PASSED");
        console.log("✅ Instagram finished processing the Reel.");
        console.log("✅ The Reel is ready for a separate publish request.");
        console.log("🚫 This test did NOT publish the Reel.");
        console.log("========================================\n");
      }
    } catch (error) {
      if (error.terminalStatus) {
        safeToDeleteHostedVideo = true;
      }

      throw error;
    }
  } finally {
    if (hostedVideo && safeToDeleteHostedVideo) {
      try {
        await deleteCloudinaryVideo(
          hostedVideo.publicId,
          credentials
        );
      } catch (error) {
        console.warn(
          "⚠️ Could not clean up the temporary hosted video:",
          error.message
        );
        console.warn(
          `Cloudinary public ID: ${hostedVideo.publicId}`
        );
      }
    } else if (hostedVideo) {
      console.warn(
        "⚠️ Retaining the hosted video because Instagram's processing " +
        "state is not safely resolved."
      );
      console.warn(`Cloudinary public ID: ${hostedVideo.publicId}`);
    }
  }
}

main().catch((error) => {
  console.error("\n❌ INSTAGRAM CONTAINER TEST FAILED");
  console.error(error.message);
  console.error("No publish request was made by this test.");
  process.exitCode = 1;
});
