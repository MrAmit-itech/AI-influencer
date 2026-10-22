
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

const {
  publishReel,
  buildInstagramCaption,
} = require("./src/phase2/instagram/publisher");

function findLatestVideo() {
  const suppliedPath = process.argv[2];

  if (suppliedPath) {
    return path.resolve(__dirname, suppliedPath);
  }

  const outputDir = path.join(__dirname, "output");

  if (!fs.existsSync(outputDir)) {
    throw new Error("The output/ folder does not exist.");
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
    .filter((item) => item.size > 0)
    .sort((a, b) => b.modified - a.modified);

  if (!videos.length) {
    throw new Error(
      "No MP4 found in output/. Generate a Reel with " +
      "CLEANUP_AFTER_DELIVERY=false, then retry."
    );
  }

  return videos[0].fullPath;
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  if (
    String(process.env.INSTAGRAM_LIVE_TEST_ENABLED || "")
      .trim()
      .toLowerCase() !== "true"
  ) {
    throw new Error(
      "Live test disabled. Set INSTAGRAM_LIVE_TEST_ENABLED=true " +
      "in your root .env to authorize this test."
    );
  }

  const videoPath = findLatestVideo();

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  const stat = fs.statSync(videoPath);

  if (!stat.isFile() || stat.size === 0) {
    throw new Error("Selected video is empty or invalid.");
  }

  const category = String(
    process.argv[3] || "default"
  ).trim().toLowerCase();

  const caption = buildInstagramCaption(category);

  console.log("\n========================================");
  console.log("⚠️ FIRST LIVE INSTAGRAM PUBLISHING TEST");
  console.log("========================================");
  console.log(`🎬 Video: ${path.relative(__dirname, videoPath)}`);
  console.log(`📦 Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`🎨 Caption category: ${category}`);
  console.log("\n----- CAPTION PREVIEW -----");
  console.log(caption);
  console.log("---------------------------");
  console.log("\nIMPORTANT:");
  console.log("- This will publish a real Reel to your Instagram account.");
  console.log("- The post may be visible to your audience.");
  console.log("- This test does not send affiliate DMs.");
  console.log("- Do not repeat the test blindly if a request times out.");

  const confirmation = await ask(
    '\nTo publish this Reel, type PUBLISH exactly: '
  );

  if (confirmation !== "PUBLISH") {
    console.log("\n⏭️ Cancelled. No Instagram publish request was made.");
    return;
  }

  console.log("\n📤 Sending Reel to Instagram...");

  const result = await publishReel({
    videoPath,
    caption,
  });

  console.log("\n✅ LIVE PUBLISHING TEST COMPLETED.");

  if (result.permalink) {
    console.log(`🔗 Instagram Reel: ${result.permalink}`);
  } else {
    console.log(
      `🆔 Published media ID: ${result.mediaId}`
    );
    console.log(
      "Open Instagram and check your Reels tab to verify publication."
    );
  }

  console.log(
    "\nℹ️ Normal run.js publishing remains disabled by " +
    "INSTAGRAM_PUBLISH_ENABLED=false."
  );
}

main().catch((error) => {
  console.error("\n❌ LIVE PUBLISHING TEST FAILED");
  console.error(error.message);
  console.error(
    "If the error occurred during the final publish request, " +
    "check your Instagram profile before retrying; the request " +
    "may have succeeded despite a network error."
  );
  process.exitCode = 1;
});
