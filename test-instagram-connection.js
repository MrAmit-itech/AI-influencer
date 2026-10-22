
"use strict";

const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

async function main() {
  const token = String(
    process.env.INSTAGRAM_ACCESS_TOKEN || ""
  ).trim();

  const configuredUserId = String(
    process.env.INSTAGRAM_USER_ID || ""
  ).trim();

  const rawVersion = String(
    process.env.INSTAGRAM_API_VERSION || "v25.0"
  ).trim();

  const apiVersion = rawVersion.startsWith("v")
    ? rawVersion
    : `v${rawVersion}`;

  if (!token) {
    throw new Error(
      "INSTAGRAM_ACCESS_TOKEN is missing from the project-root .env file."
    );
  }

  const url = new URL(
    `https://graph.instagram.com/${apiVersion}/me`
  );

  url.searchParams.set("fields", "user_id,username");

  console.log("🔎 Testing Instagram API connection...");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message ||
      `Instagram API returned HTTP ${response.status}.`
    );
  }

  if (!data.user_id || !data.username) {
    throw new Error(
      "Instagram returned an unexpected profile response. " +
      "Expected user_id and username fields."
    );
  }

  console.log("\n✅ INSTAGRAM CONNECTION SUCCESSFUL");
  console.log(`👤 Instagram username: @${data.username}`);
  console.log(`🆔 Instagram User ID: ${data.user_id}`);

  if (!configuredUserId) {
    console.log("\n⚠️ INSTAGRAM_USER_ID is missing from .env.");
    console.log(
      `Add this value: INSTAGRAM_USER_ID=${data.user_id}`
    );
  } else if (configuredUserId !== String(data.user_id)) {
    console.log("\n⚠️ The configured Instagram User ID does not match.");
    console.log(
      `Update INSTAGRAM_USER_ID=${data.user_id} in .env`
    );
  } else {
    console.log("✅ INSTAGRAM_USER_ID matches the API response.");
  }

  console.log(
    "\nℹ️ This was a read-only test. No post was created."
  );
}

main().catch((error) => {
  console.error("\n❌ INSTAGRAM CONNECTION FAILED");
  console.error(error.message);
  process.exitCode = 1;
});
