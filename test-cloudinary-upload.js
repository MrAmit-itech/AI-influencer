
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} is missing from your project .env file.`);
  }

  return value;
}

function signParams(params, apiSecret) {
  const serialized = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(serialized + apiSecret)
    .digest("hex");
}

function findTestVideo() {
  // An explicitly supplied path takes priority.
  const suppliedPath = process.argv[2];

  if (suppliedPath) {
    return path.resolve(__dirname, suppliedPath);
  }

  // Prefer the final Reel in output/. If it was cleaned up,
  // use the newest available clip in clips/ instead.
  for (const folder of ["output", "clips"]) {
    const directory = path.join(__dirname, folder);

    if (!fs.existsSync(directory)) continue;

    const videos = fs
      .readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith(".mp4"))
      .map((name) => {
        const fullPath = path.join(directory, name);

        return {
          fullPath,
          modified: fs.statSync(fullPath).mtimeMs,
          size: fs.statSync(fullPath).size,
        };
      })
      .filter((file) => file.size > 0)
      .sort((a, b) => b.modified - a.modified);

    if (videos.length) {
      return videos[0].fullPath;
    }
  }

  throw new Error(
    "No MP4 found in output/ or clips/. " +
    'Supply a video path, for example: node test-cloudinary-upload.js "output/my-reel.mp4"'
  );
}

async function parseResponse(response, label) {
  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(`${label}: Cloudinary returned an invalid response.`);
  }

  if (!response.ok || data.error) {
    throw new Error(
      `${label}: ${
        data.error?.message || `HTTP ${response.status}`
      }`
    );
  }

  return data;
}

async function uploadVideo(videoPath, credentials) {
  const timestamp = String(Math.floor(Date.now() / 1000));

  // This identifier contains no sensitive information.
  const publicId =
    `temporary_instagram_test_${Date.now()}_` +
    crypto.randomBytes(3).toString("hex");

  const params = {
    public_id: publicId,
    timestamp,
  };

  const signature = signParams(params, credentials.apiSecret);

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

  const endpoint =
    `https://api.cloudinary.com/v1_1/` +
    `${encodeURIComponent(credentials.cloudName)}/video/upload`;

  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  const result = await parseResponse(response, "Video upload");

  if (!result.secure_url || !result.public_id) {
    throw new Error(
      "Upload response did not include secure_url and public_id."
    );
  }

  return {
    publicId: result.public_id,
    secureUrl: result.secure_url,
  };
}

async function verifyPublicUrl(url) {
  // First try HEAD to verify access without downloading the video.
  let response = await fetch(url, { method: "HEAD" });

  if (response.ok) return true;

  // Some delivery layers handle byte-range GET more reliably.
  response = await fetch(url, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
  });

  const reachable = response.ok;

  if (response.body) {
    await response.body.cancel().catch(() => {});
  }

  return reachable;
}

async function deleteTestVideo(publicId, credentials) {
  const timestamp = String(Math.floor(Date.now() / 1000));

  const params = {
    public_id: publicId,
    timestamp,
  };

  const signature = signParams(params, credentials.apiSecret);
  const form = new FormData();

  form.append("public_id", publicId);
  form.append("timestamp", timestamp);
  form.append("api_key", credentials.apiKey);
  form.append("signature", signature);

  const endpoint =
    `https://api.cloudinary.com/v1_1/` +
    `${encodeURIComponent(credentials.cloudName)}/video/destroy`;

  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  const result = await parseResponse(response, "Temporary asset deletion");

  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error(
      `Cloudinary did not confirm asset deletion: ${result.result}`
    );
  }

  console.log("🧹 Temporary Cloudinary video deleted.");
}

async function main() {
  const credentials = {
    cloudName: requiredEnv("CLOUDINARY_CLOUD_NAME"),
    apiKey: requiredEnv("CLOUDINARY_API_KEY"),
    apiSecret: requiredEnv("CLOUDINARY_API_SECRET"),
  };

  const videoPath = findTestVideo();

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const stats = fs.statSync(videoPath);

  if (!stats.isFile() || stats.size === 0) {
    throw new Error("Selected MP4 is empty or invalid.");
  }

  console.log("🔎 Testing Cloudinary upload...");
  console.log(`🎬 Video: ${path.relative(__dirname, videoPath)}`);
  console.log(`📦 Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  let uploadedAsset = null;
  let testSucceeded = false;

  try {
    uploadedAsset = await uploadVideo(videoPath, credentials);

    console.log("✅ Upload succeeded.");
    console.log("🌐 Checking public HTTPS URL...");

    const reachable = await verifyPublicUrl(uploadedAsset.secureUrl);

    if (!reachable) {
      throw new Error(
        "The uploaded URL could not be reached publicly. " +
        "Check Cloudinary delivery settings and retry."
      );
    }

    testSucceeded = true;

    console.log("✅ CLOUDINARY TEST PASSED");
    console.log("✅ Public HTTPS URL is reachable.");
    console.log("✅ No Instagram post was created.");
  } finally {
    if (uploadedAsset) {
      try {
        await deleteTestVideo(uploadedAsset.publicId, credentials);
      } catch (error) {
        console.error(
          "⚠️ Could not delete the temporary Cloudinary asset:",
          error.message
        );
        console.error(
          "Open Cloudinary Media Library and remove the temporary video manually."
        );
      }
    }
  }

  if (testSucceeded) {
    console.log("\n🎉 Cloudinary is ready for the next integration test.");
  }
}

main().catch((error) => {
  console.error("\n❌ CLOUDINARY TEST FAILED");
  console.error(error.message);
  process.exitCode = 1;
});
