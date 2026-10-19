const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const sharp = require("sharp");
const readline = require("readline");
const { execFileSync, spawnSync } = require("child_process");
const { chromium } = require("playwright");
const ffmpegPath = require("ffmpeg-static");
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
let CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const CHARACTER_IMAGE_RAW = (
  process.env.CHARACTER_IMAGE_PATH || "character_reference.png"
).trim();

const CHARACTER_IMAGE_PATH = path.isAbsolute(CHARACTER_IMAGE_RAW)
  ? CHARACTER_IMAGE_RAW
  : path.resolve(__dirname, CHARACTER_IMAGE_RAW);
const DEFAULT_AFFILIATE_TAG = (
  process.env.AMAZON_AFFILIATE_TAG || "yourtag-21"
).trim();
const FLOW_URL = "https://labs.google/fx/tools/flow";
if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in your .env file!");
  process.exit(1);
}
const DIRS = {
  tempImages: path.join(__dirname, "temp_images"),
  clips: path.join(__dirname, "clips"),
  output: path.join(__dirname, "output"),
  profile: path.join(__dirname, ".bot-profile"),
};
Object.values(DIRS).forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
function copyToWindowsClipboard(text) {
  try {
    spawnSync("clip", [], { input: text, encoding: "utf8" });
  } catch {}
}
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}
async function resolveUserChoices() {
  let videoMode = (process.env.VIDEO_MODE || "").trim().toUpperCase();
  if (videoMode !== "OPTION_A" && videoMode !== "OPTION_B") {
    console.log("\n======================================================");
    console.log("🎥 SELECT YOUR 20-SEC REEL MODE:");
    console.log("   [A] Option A: 5-Dress Haul (All 5 dresses x 4s clip each)");
    console.log(
      "   [B] Option B: 1-Dress 5-Poses (1st dress x 5 camera angles)",
    );
    console.log("======================================================");
    const ans = (
      await askQuestion("👉 Type A or B (Press Enter for A): ")
    ).toUpperCase();
    videoMode = ans === "B" ? "OPTION_B" : "OPTION_A";
  }
  return { videoMode, affiliateTag: DEFAULT_AFFILIATE_TAG };
}
async function tgApi(method, payload = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.description || `Telegram API error on ${method}`);
  return data.result;
}
async function ensureChatId() {
  if (!BOT_TOKEN) return null;
  if (CHAT_ID) return CHAT_ID;
  const updates = await tgApi("getUpdates", { offset: -5 }).catch(() => []);
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    const id = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
    if (id) {
      CHAT_ID = String(id);
      return CHAT_ID;
    }
  }
  return null;
}
async function sendFinalVideoToTelegram(videoPath, captionText) {
  const targetChatId = await ensureChatId();
  if (!BOT_TOKEN || !targetChatId) {
    console.log(
      'ℹ️ Telegram Chat ID not set. Open your finished Reel inside the "output" folder.',
    );
    return;
  }
  console.log(
    "\n📲 Uploading finished 20-sec Reel & Affiliate Links to Telegram...",
  );
  const videoBuffer = fs.readFileSync(videoPath);
  const formData = new FormData();
  formData.append("chat_id", targetChatId);
  formData.append("caption", captionText.slice(0, 1024));
  formData.append(
    "video",
    new Blob([videoBuffer], { type: "video/mp4" }),
    path.basename(videoPath),
  );
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`,
    { method: "POST", body: formData },
  );
  const data = await res.json();
  if (!data.ok)
    throw new Error(`Telegram video upload failed: ${data.description}`);
  console.log("✅ Delivered 20-sec Reel to your Telegram Bot!");
}
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
let cachedWorkingModels = null;
async function getAvailableVisionModels() {
  if (cachedWorkingModels) return cachedWorkingModels;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`,
    );
    const data = await res.json();
    if (data.models) {
      const names = data.models
        .filter((m) =>
          m.supportedGenerationMethods?.includes("generateContent"),
        )
        .map((m) => m.name.replace("models/", ""))
        .filter(
          (name) =>
            /flash|lite|pro/i.test(name) &&
            !/tts|audio|imagen|veo|embedding/i.test(name),
        );
      names.sort((a, b) => {
        const score = (n) =>
          n.includes("lite") ? 1 : n.includes("flash") ? 2 : 3;
        return score(a) - score(b);
      });
      if (names.length > 0) {
        cachedWorkingModels = names;
        console.log(
          `   🔍 Auto-detected available Gemini models: ${names.slice(0, 4).join(", ")}`,
        );
        return cachedWorkingModels;
      }
    }
  } catch {}
  cachedWorkingModels = [
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ];
  return cachedWorkingModels;
}

async function detectMainFaceBoxWithGemini(imageBuffer) {
  const base64Image = imageBuffer.toString("base64");

  const instruction = `
Inspect this fashion product image and locate the primary model's visible face.

Return ONLY valid JSON in this exact structure:
{
  "faceFound": true,
  "box": {
    "x1": 200,
    "y1": 100,
    "x2": 450,
    "y2": 400
  }
}

Rules:
- Coordinates must be normalized from 0 to 1000 relative to the FULL image.
- x1 and y1 are the top-left corner; x2 and y2 are the bottom-right.
- Enclose the entire visible face, including forehead, cheeks and chin.
- Keep the box tight around the face; do not include the dress or torso.
- Locate the primary fashion model's face, not faces in the background.
- If no human face is visible, return:
  {"faceFound": false, "box": null}
- Return JSON only, without Markdown or explanations.
`.trim();

  const models = await getAvailableVisionModels();
  let lastError = "No valid face-detection response was received.";

  for (const modelName of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const endpoint =
          `https://generativelanguage.googleapis.com/v1beta/models/` +
          `${modelName}:generateContent?key=${GEMINI_API_KEY}`;

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: base64Image,
                    },
                  },
                  { text: instruction },
                ],
              },
            ],
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          lastError = data.error?.message || `HTTP ${res.status}`;

          if (
            res.status === 429 ||
            res.status === 503 ||
            /overloaded|high demand|quota/i.test(lastError)
          ) {
            console.warn(
              `   ⚠️ Face detection: ${modelName}, attempt ${attempt}/2 failed. Retrying...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }

          break;
        }

        const rawText = (
          data.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("\n") || ""
        )
          .trim()
          .replace(/^```json/i, "")
          .replace(/^```/i, "")
          .replace(/```$/i, "")
          .trim();

        const start = rawText.indexOf("{");
        const end = rawText.lastIndexOf("}");

        if (start < 0 || end <= start) {
          lastError = "Gemini did not return a valid JSON object.";
          break;
        }

        const result = JSON.parse(rawText.slice(start, end + 1));

        if (result.faceFound === false) {
          return null;
        }

        const box = result.box;
        const keys = ["x1", "y1", "x2", "y2"];

        const validBox =
          result.faceFound === true &&
          box &&
          keys.every(
            (key) =>
              Number.isFinite(Number(box[key])) &&
              Number(box[key]) >= 0 &&
              Number(box[key]) <= 1000,
          ) &&
          Number(box.x2) > Number(box.x1) &&
          Number(box.y2) > Number(box.y1);

        if (validBox) {
          return {
            x1: Number(box.x1),
            y1: Number(box.y1),
            x2: Number(box.x2),
            y2: Number(box.y2),
          };
        }

        lastError = "Gemini returned invalid face coordinates.";
        break;
      } catch (error) {
        lastError = error.message;
      }
    }
  }

  // Stop instead of silently sending an unblurred face to Flow.
  throw new Error(`Could not locate the model's face safely. ${lastError}`);
}

async function prepareDressReferenceImage(inputPath, outputPath) {
  console.log(`   🖼️ Preparing dress reference: ${path.basename(inputPath)}`);

  // Normalize orientation and convert to JPEG before detection.
  const imageBuffer = await sharp(inputPath)
    .rotate()
    .jpeg({ quality: 95 })
    .toBuffer();

  const metadata = await sharp(imageBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Could not read image dimensions: ${inputPath}`);
  }

  const width = metadata.width;
  const height = metadata.height;

  const faceBox = await detectMainFaceBoxWithGemini(imageBuffer);

  // Product photos sometimes contain no visible person or face.
  if (!faceBox) {
    await sharp(imageBuffer).jpeg({ quality: 95 }).toFile(outputPath);

    console.log("   ℹ️ No visible face detected; preserved the product image.");
    return outputPath;
  }

  // Convert normalized coordinates into actual image pixels.
  const faceLeft = Math.max(
    0,
    Math.min(width - 1, Math.floor((faceBox.x1 / 1000) * width)),
  );

  const faceTop = Math.max(
    0,
    Math.min(height - 1, Math.floor((faceBox.y1 / 1000) * height)),
  );

  const faceRight = Math.max(
    faceLeft + 1,
    Math.min(width, Math.ceil((faceBox.x2 / 1000) * width)),
  );

  const faceBottom = Math.max(
    faceTop + 1,
    Math.min(height, Math.ceil((faceBox.y2 / 1000) * height)),
  );

  // Add a margin so the blur covers the whole face despite
  // small inaccuracies in the detected coordinates.
  const paddingX = Math.max(8, Math.round((faceRight - faceLeft) * 0.22));

  const paddingY = Math.max(8, Math.round((faceBottom - faceTop) * 0.22));

  const left = Math.max(0, faceLeft - paddingX);
  const top = Math.max(0, faceTop - paddingY);
  const right = Math.min(width, faceRight + paddingX);
  const bottom = Math.min(height, faceBottom + paddingY);

  const region = {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };

  // Blur only the face region and composite it back into the full image.
  const blurredRegion = await sharp(imageBuffer)
    .extract(region)
    .blur(24)
    .jpeg({ quality: 95 })
    .toBuffer();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await sharp(imageBuffer)
    .composite([
      {
        input: blurredRegion,
        left: region.left,
        top: region.top,
      },
    ])
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  console.log(
    `   ✅ Face blurred; full dress reference preserved: ${outputPath}`,
  );

  return outputPath;
}

function buildLocalBackupPrompts(dressTitle, count = 1) {
  const cleanTitle = dressTitle.replace(/[^\w\s,-]/g, "").slice(0, 70);
  const poses = [
    `Vertical 9:16 4K fashion film. Silent Indian female model wearing the exact uploaded ingredient dress (${cleanTitle}), walking gracefully in slow motion toward the camera with a soft serene smile, no speaking, sunlit luxury heritage courtyard backdrop, shallow depth of field, warm golden hour lighting.`,
    `Vertical 9:16 4K fashion film. Silent Indian female model wearing the exact uploaded ingredient dress (${cleanTitle}), doing a slow graceful turn to showcase the dress flare and fabric flow, poised expression, no lip movement, aesthetic golden-hour terrace backdrop, cinematic gimbal pan.`,
    `Vertical 9:16 4K fashion film. Silent Indian female model wearing the exact uploaded ingredient dress (${cleanTitle}), medium close-up shot highlighting neckline and fabric texture, gently brushing hair back with a calm confident gaze, no speaking, soft bokeh background.`,
    `Vertical 9:16 4K fashion film. Silent Indian female model wearing the exact uploaded ingredient dress (${cleanTitle}), looking over her shoulder with a soft elegant smile, slow camera push-in, warm golden sunlight, luxury Pinterest aesthetic backdrop.`,
    `Vertical 9:16 4K fashion film. Silent Indian female model wearing the exact uploaded ingredient dress (${cleanTitle}), full-body editorial pose with subtle slow-motion fabric movement, serene expression, no speaking, sunlit botanical courtyard.`,
  ];
  return poses.slice(0, count);
}
async function generateSilentModelPrompts(imagePath, dressTitle, count = 1) {
  const imageBytes = fs.readFileSync(imagePath);
  const base64Image = imageBytes.toString("base64");
  const promptInstruction =
    `Analyze this women's dress image ("${dressTitle}") for Google Flow (Omni 1.1 Flash, Ingredients mode).\nWrite ${count} vertical 9:16 video generation prompt(s).\nRules:\n1. Silent Indian female fashion model wearing the exact uploaded dress (describe color, fabric, cut, embroidery). No speaking or lip movement.\n2. Smooth 4-second slow-motion movement + subtle camera movement.\n3. Matching luxury/festive Pinterest backdrop with golden-hour lighting.\nReturn ONLY a valid JSON array of ${count} string prompt(s). No markdown blocks.`.trim();
  const modelsToTry = await getAvailableVisionModels();
  for (const modelName of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: { mime_type: "image/jpeg", data: base64Image },
                  },
                  { text: promptInstruction },
                ],
              },
            ],
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = data.error?.message || `HTTP ${res.status}`;
          if (
            res.status === 503 ||
            res.status === 429 ||
            /overloaded|demand|quota/i.test(msg)
          ) {
            console.warn(
              `   ⚠️ [${modelName}] High demand (Attempt ${attempt}/2). Switching/retrying in 3s...`,
            );
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          break;
        }
        const rawText = (data.candidates?.[0]?.content?.parts?.[0]?.text || "")
          .trim()
          .replace(/^```json/i, "")
          .replace(/^```/i, "")
          .replace(/```$/i, "")
          .trim();
        if (rawText) {
          console.log(`   ✅ Prompt generated using [${modelName}]`);
          try {
            const parsed = JSON.parse(rawText);
            return Array.isArray(parsed) ? parsed : [rawText];
          } catch {
            return [rawText];
          }
        }
      } catch (err) {
        console.warn(`   ⚠️ [${modelName}] Network error: ${err.message}`);
      }
    }
  }
  console.log(
    "   ⚡ All Gemini servers busy—using built-in Fashion Director prompt so pipeline continues!",
  );
  return buildLocalBackupPrompts(dressTitle, count);
}

const FLOW_GENERATION_TIMEOUT_MS = Math.max(
  60000,
  Number(process.env.FLOW_GENERATION_TIMEOUT_MS || 240000),
);
const FLOW_DOWNLOAD_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.FLOW_DOWNLOAD_TIMEOUT_MS || 45000),
);
async function findVisibleLocator(page, selectors, options = {}) {
  const searchLast = options.last !== false;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const indices = searchLast
      ? Array.from({ length: count }, (_, index) => count - 1 - index)
      : Array.from({ length: count }, (_, index) => index);
    for (const index of indices) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (options.enabled && !(await candidate.isEnabled().catch(() => false)))
        continue;
      return candidate;
    }
  }
  return null;
}
async function captureFlowDiagnostics(page, label) {
  const safeLabel =
    String(label || "flow")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "flow";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basePath = path.join(DIRS.output, `flow-debug-${safeLabel}-${stamp}`);
  const jsonPath = `${basePath}.json`;
  const pngPath = `${basePath}.png`;
  try {
    const snapshot = await page.evaluate(() => {
      const visible = (element) =>
        Boolean(element && element.getClientRects().length);
      const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        text: String(
          element.innerText ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            "",
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        disabled: Boolean(element.disabled),
        role: element.getAttribute("role"),
      });
      return {
        url: location.href,
        title: document.title,
        bodyTextTail: (document.body?.innerText || "").slice(-12000),
        visibleControls: Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="menuitem"]',
          ),
        )
          .filter(visible)
          .slice(-100)
          .map(describe),
        videos: Array.from(document.querySelectorAll("video")).map((video) => ({
          src: video.currentSrc || video.src || "",
          poster: video.poster || "",
          readyState: video.readyState,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          visible: visible(video),
        })),
        images: Array.from(document.querySelectorAll("img"))
          .filter(visible)
          .slice(-80)
          .map((img) => ({
            src: img.currentSrc || img.src || "",
            alt: img.alt || "",
          })),
      };
    });
    fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ error: error.message }, null, 2),
      "utf8",
    );
  }
  try {
    await page.screenshot({ path: pngPath, fullPage: true, timeout: 15000 });
  } catch (error) {
    console.warn(`   ⚠️ Could not save Flow screenshot: ${error.message}`);
  }
  console.log(`   🧾 Flow diagnostics saved: ${jsonPath}`);
  console.log(`   🖼️ Flow screenshot saved: ${pngPath}`);
  return { jsonPath, pngPath };
}
async function getFlowMediaSnapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element || !element.getClientRects().length) {
        return false;
      }

      const style = window.getComputedStyle(element);

      return style.display !== "none" && style.visibility !== "hidden";
    };

    const cleanText = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);

    // All visible HTML video elements. These are diagnostic signals;
    // the specific Flow video card below is the primary target.
    const videos = Array.from(document.querySelectorAll("video")).map(
      (video, domIndex) => ({
        domIndex,
        src: video.currentSrc || video.src || "",
        poster: video.poster || "",
        visible: visible(video),
        readyState: video.readyState,
        duration: Number.isFinite(video.duration) ? video.duration : null,
      }),
    );

    const imageDetails = Array.from(document.querySelectorAll("img"))
      .map((img, domIndex) => {
        if (!visible(img)) return null;

        return {
          domIndex,
          src: img.currentSrc || img.src || "",
          alt: img.alt || "",
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
        };
      })
      .filter(Boolean)
      .filter((img) => img.src);

    // IMPORTANT: only flow-video-tile elements qualify as
    // generated video assets. A standalone image cannot qualify.
    const allContainers = Array.from(
      document.querySelectorAll("flow-tile-container"),
    );

    const videoTiles = Array.from(document.querySelectorAll("flow-video-tile"))
      .map((tile, domIndex) => {
        if (!visible(tile)) return null;

        const thumbnail = tile.querySelector("img.thumbnail, img.image, img");

        const thumbnailSrc = thumbnail
          ? thumbnail.currentSrc ||
            thumbnail.src ||
            thumbnail.getAttribute("src") ||
            ""
          : "";

        const nestedVideos = Array.from(tile.querySelectorAll("video")).map(
          (video) => ({
            src: video.currentSrc || video.src || "",
            poster: video.poster || "",
          }),
        );

        const videoSrc =
          nestedVideos.map((video) => video.src).find(Boolean) || "";

        const poster =
          nestedVideos.map((video) => video.poster).find(Boolean) || "";

        const parentContainer = tile.closest("flow-tile-container");

        const containerIndex = parentContainer
          ? allContainers.indexOf(parentContainer)
          : -1;

        const identity =
          tile.getAttribute("data-asset-id") ||
          tile.getAttribute("data-id") ||
          tile.id ||
          "";

        const signature = [identity, thumbnailSrc, videoSrc, poster].join("::");

        const pendingSelectors = [
          "flow-pending-tile",
          ".progress-bar",
          ".hover-overlay-has-progress-bar",
          '[aria-busy="true"]',
        ];

        const pending = pendingSelectors.some((selector) =>
          Array.from(tile.querySelectorAll(selector)).some(visible),
        );

        const failed = Boolean(
          tile.querySelector(
            "flow-error-tile, .error-tile, .error-tile-content",
          ),
        );

        const mediaSource = thumbnailSrc || videoSrc || poster;

        const hasUsableMedia =
          Boolean(mediaSource) &&
          !mediaSource.startsWith("data:image/svg") &&
          !mediaSource.includes("placeholder");

        return {
          kind: "video-tile",
          domIndex,
          containerIndex,
          identity,
          thumbnailSrc,
          videoSrc,
          poster,
          signature,
          pending,
          failed,
          hasUsableMedia,
          complete: hasUsableMedia && !pending && !failed,
          text: cleanText(tile.innerText || ""),
        };
      })
      .filter(Boolean);

    // Generic cards remain available for diagnostics only.
    // They are never accepted as generated-video evidence.
    const assetTileCount = allContainers.filter(visible).length;

    const busyElement = Array.from(
      document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], progress',
      ),
    ).some(visible);

    const bodyText = document.body?.innerText || "";

    const busyText =
      /\b(generating video|creating video|rendering video|processing video|in queue|queued|generation in progress)\b/i.test(
        bodyText,
      );

    const downloadControlCount = Array.from(
      document.querySelectorAll('button, [role="button"]'),
    )
      .filter(visible)
      .filter((element) =>
        /download/i.test(
          `${element.getAttribute("aria-label") || ""} ${
            element.getAttribute("title") || ""
          } ${element.innerText || ""}`,
        ),
      ).length;

    return {
      videos,
      videoTiles,
      images: imageDetails.map((img) => img.src),
      imageDetails,
      assetTiles: [],
      videoCount: videos.length,
      videoTileCount: videoTiles.length,
      assetTileCount,
      downloadControlCount,
      visibleMediaCount:
        videos.filter((video) => video.visible).length + imageDetails.length,
      busy: busyElement || busyText,
    };
  });
}

async function openDetectedFlowAsset(page, candidate, clipIndex) {
  const assetSelector = '[role="gridcell"], [data-testid*="asset" i]';

  if (candidate?.kind === "tile") {
    const tile = page.locator(assetSelector).nth(candidate.item.domIndex);

    if (await tile.isVisible().catch(() => false)) {
      await tile.scrollIntoViewIfNeeded().catch(() => {});

      try {
        await tile.click({ timeout: 8000 });
        console.log(
          `   🖱️ Opened the newly detected Flow asset for clip ${clipIndex}.`,
        );
        await page.waitForTimeout(1200);
        return true;
      } catch (error) {
        console.warn(
          `   ⚠️ Could not open the new asset tile: ${error.message}`,
        );
      }
    }
  }

  if (candidate?.kind === "image") {
    const image = page.locator("img").nth(candidate.item.domIndex);

    if (await image.isVisible().catch(() => false)) {
      await image.scrollIntoViewIfNeeded().catch(() => {});

      try {
        await image.click({ timeout: 8000 });
        console.log(
          `   🖱️ Opened the newly detected media thumbnail for clip ${clipIndex}.`,
        );
        await page.waitForTimeout(1200);
        return true;
      } catch (error) {
        console.warn(
          `   ⚠️ Could not open the new thumbnail: ${error.message}`,
        );
      }
    }
  }

  return false;
}

async function waitForNewGeneratedAsset(page, baseline, clipIndex) {
  const deadline = Date.now() + FLOW_GENERATION_TIMEOUT_MS;

  const oldVideoTileSignatures = new Set(
    (baseline.videoTiles || []).map((tile) => tile.signature),
  );

  const baselineVideoTileCount = Number(baseline.videoTileCount || 0);

  let lastCandidateKey = null;
  let consecutiveReadyChecks = 0;
  let lastLogAt = 0;

  console.log(
    `   ⏳ Waiting up to ${Math.round(
      FLOW_GENERATION_TIMEOUT_MS / 1000,
    )}s for a new video card for clip ${clipIndex}...`,
  );

  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);

    const current = await getFlowMediaSnapshot(page).catch(() => null);

    if (!current) continue;

    const hasAdditionalVideoTile =
      Number(current.videoTileCount || 0) > baselineVideoTileCount;

    const newVideoTiles = (current.videoTiles || []).filter(
      (tile) => !oldVideoTileSignatures.has(tile.signature),
    );

    let candidate = null;

    if (hasAdditionalVideoTile) {
      // Prefer a new tile whose signature wasn't in the baseline.
      // Do not require containerIndex === 0 or a loaded preview URL.
      candidate = newVideoTiles.find(
  (tile) => tile.hasUsableMedia && !tile.failed
) || null;

      // Some Flow cards don't expose a usable media URL immediately.
      // If the count increased but the signature did not change,
      // use the first/newest visible video-specific card as a fallback.
      if (!candidate && newVideoTiles.length === 0) {
        const newestVideoTile = (current.videoTiles || [])[0];

        if (
          newestVideoTile &&
          !newestVideoTile.pending &&
          !newestVideoTile.failed
        ) {
          candidate = newestVideoTile;
        }
      }
    }

    const candidateKey = candidate
      ? `${candidate.signature}|${candidate.domIndex}|${candidate.containerIndex}`
      : null;

    if (candidate && !current.busy) {
      if (candidateKey === lastCandidateKey) {
        consecutiveReadyChecks++;
      } else {
        lastCandidateKey = candidateKey;
        consecutiveReadyChecks = 1;
      }
    } else {
      lastCandidateKey = null;
      consecutiveReadyChecks = 0;
    }

    // Confirm the same specific video card across consecutive checks.
    if (candidate && consecutiveReadyChecks >= 3) {
      console.log(
        `   ✅ Stable Flow video card detected for clip ${clipIndex}.`,
      );

      console.log(
        `   🎯 Video tile index: ${candidate.domIndex}; ` +
          `container index: ${candidate.containerIndex}; ` +
          `preview source: ${candidate.thumbnailSrc ? "available" : "not exposed yet"}`,
      );

      return {
        ...current,
        generatedAsset: {
          kind: "video-tile",
          domIndex: candidate.domIndex,
          containerIndex: candidate.containerIndex,
          src:
            candidate.thumbnailSrc ||
            candidate.videoSrc ||
            candidate.poster ||
            "",
          signature: candidate.signature,
        },
      };
    }

    if (Date.now() - lastLogAt >= 15000) {
      console.log(
        `   … waiting (video cards: ${current.videoTileCount}, ` +
          `baseline: ${baselineVideoTileCount}, ` +
          `new signatures: ${newVideoTiles.length}, ` +
          `activity: ${current.busy ? "busy" : "idle"})`,
      );

      // Log tile states to help diagnose future UI changes.
      console.log(
        "   🔎 Video card states:",
        JSON.stringify(
          (current.videoTiles || []).map((tile) => ({
            domIndex: tile.domIndex,
            containerIndex: tile.containerIndex,
            pending: tile.pending,
            failed: tile.failed,
            hasMediaSource: tile.hasUsableMedia,
            complete: tile.complete,
          })),
        ),
      );

      lastLogAt = Date.now();
    }
  }

  await captureFlowDiagnostics(page, `clip-${clipIndex}-video-tile-timeout`);

  throw new Error(
    `Flow did not expose a stable, completed video-specific card within ` +
      `${Math.round(FLOW_GENERATION_TIMEOUT_MS / 1000)} seconds for clip ${clipIndex}. ` +
      "Check the saved Flow debug JSON and screenshot.",
  );
}

async function hoverLatestFlowAsset(page) {
  const video = await findVisibleLocator(page, ["video"], { last: true });
  if (video) {
    await video.scrollIntoViewIfNeeded().catch(() => {});
    await video.hover({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }
  const tile = await findVisibleLocator(
    page,
    ['[role="gridcell"]', '[data-testid*="asset" i]', "img"],
    { last: true },
  );
  if (tile) {
    await tile.scrollIntoViewIfNeeded().catch(() => {});
    await tile.hover({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function savePlaywrightDownload(download, destinationPath) {
  await download.saveAs(destinationPath);

  if (!fs.existsSync(destinationPath)) {
    throw new Error(
      "Playwright reported a download, but the destination file was not created.",
    );
  }

  const stat = fs.statSync(destinationPath);

  if (stat.size < 1024) {
    fs.unlinkSync(destinationPath);

    throw new Error(
      `Downloaded file is unexpectedly small (${stat.size} bytes).`,
    );
  }

  const failure = await download.failure().catch(() => null);

  if (failure) {
    fs.unlinkSync(destinationPath);

    throw new Error(`Browser download failed: ${failure}`);
  }

  // MP4 files normally contain the ISO Base Media File Format
  // signature "ftyp" at byte offset 4.
  const fd = fs.openSync(destinationPath, "r");
  const header = Buffer.alloc(12);

  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const isMp4 = header.length >= 8 && header.toString("ascii", 4, 8) === "ftyp";

  if (!isMp4) {
    const detectedType =
      header[0] === 0xff && header[1] === 0xd8
        ? "JPEG image"
        : header[0] === 0x89 && header.toString("ascii", 1, 4) === "PNG"
          ? "PNG image"
          : "unknown file type";

    fs.unlinkSync(destinationPath);

    throw new Error(
      `Flow download was not an MP4 video (detected: ${detectedType}). ` +
        `Rejected file: ${download.suggestedFilename()}. ` +
        "Check that Flow generated a video and that the correct asset was downloaded.",
    );
  }

  console.log(
    `   ✅ Verified MP4 download: ${destinationPath} ` +
      `(${(stat.size / (1024 * 1024)).toFixed(2)} MB; ${download.suggestedFilename()})`,
  );

  return true;
}

async function clickAndSaveIfDownloadStarts(
  page,
  locator,
  destinationPath,
  timeoutMs,
) {
  if (!locator) return false;
  const downloadPromise = page
    .waitForEvent("download", { timeout: timeoutMs })
    .catch(() => null);
  await locator.click({ timeout: 8000 });
  const download = await downloadPromise;
  if (!download) return false;
  await savePlaywrightDownload(download, destinationPath);
  return true;
}

async function waitForFlowResolutionOption(
  page,
  resolution,
  timeoutMs = 12000,
) {
  const deadline = Date.now() + timeoutMs;

  const selectors = [
    `flow-menu-item button:has-text("${resolution}")`,
    `button[role="menuitem"]:has-text("${resolution}")`,
    `button:has-text("${resolution}")`,
    `[role="menuitem"]:has-text("${resolution}")`,
    `[role="option"]:has-text("${resolution}")`,
    `text=/\\b${resolution}\\b/i`,
  ];

  while (Date.now() < deadline) {
    // Search the newest visible menu surfaces first.
    const menus = page.locator("div.mat-mdc-menu-content");
    const count = await menus.count().catch(() => 0);

    for (let i = count - 1; i >= 0; i--) {
      const menu = menus.nth(i);

      if (!(await menu.isVisible().catch(() => false))) {
        continue;
      }

      const option = await findVisibleLocator(menu, selectors, {
        last: false,
        enabled: true,
      });

      if (option) {
        return option;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}
async function attemptFlowDownload(
  page,
  destinationPath,
  resolution,
  generatedAsset = null,
) {
  if (!generatedAsset) {
    await captureFlowDiagnostics(page, "download-missing-asset-reference");

    throw new Error(
      "Cannot download because the newly generated asset was not identified. " +
        "Refusing to use a global menu that could download the whole project.",
    );
  }

  if (resolution !== "720p") {
    throw new Error(
      `Unexpected export resolution "${resolution}". This pipeline requires 720p.`,
    );
  }

  console.log(
    `   🎯 Locating the generated asset for clip download (clip menu, not project menu)...`,
  );

  // Only the specifically detected Flow video tile is allowed.
  // Do not locate a generic image or the latest arbitrary thumbnail.

  if (
    !generatedAsset ||
    generatedAsset.kind !== "video-tile" ||
    (!generatedAsset.signature && !Number.isInteger(generatedAsset.domIndex))
  ) {
    await captureFlowDiagnostics(
      page,
      "download-invalid-video-asset-reference",
    );

    throw new Error(
      "Download refused: no verified video-card identity was supplied.",
    );
  }

  const videoTilesLocator = page.locator("flow-video-tile");

  // First try matching the exact card signature captured during detection.
  // If that changed, accept the source URL only if it uniquely identifies
  // one video card.
  const matches = await videoTilesLocator
    .evaluateAll(
      (tiles, target) => {
        const meta = tiles.map((tile) => {
          const thumbnail = tile.querySelector("img.thumbnail, img.image, img");

          const thumbnailSrc = thumbnail
            ? thumbnail.currentSrc ||
              thumbnail.src ||
              thumbnail.getAttribute("src") ||
              ""
            : "";

          const nestedVideos = Array.from(tile.querySelectorAll("video")).map(
            (video) => ({
              src: video.currentSrc || video.src || "",
              poster: video.poster || "",
            }),
          );

          const videoSrc =
            nestedVideos.map((video) => video.src).find(Boolean) || "";

          const poster =
            nestedVideos.map((video) => video.poster).find(Boolean) || "";

          const identity =
            tile.getAttribute("data-asset-id") ||
            tile.getAttribute("data-id") ||
            tile.id ||
            "";

          return {
            signature: [identity, thumbnailSrc, videoSrc, poster].join("::"),
            sources: [thumbnailSrc, videoSrc, poster].filter(Boolean),
          };
        });

        // First try the exact DOM index captured for the newly detected tile.
        // This works even when Flow hasn't exposed its preview URL.
        const capturedIndex = target.domIndex;

        if (
          Number.isInteger(capturedIndex) &&
          capturedIndex >= 0 &&
          meta[capturedIndex] &&
          meta[capturedIndex].signature === target.signature
        ) {
          return {
            index: capturedIndex,
            matchType: "captured video-tile identity",
          };
        }

        // Otherwise, use a unique signature match.
        const exactMatches = meta
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.signature === target.signature);

        if (exactMatches.length === 1) {
          return {
            index: exactMatches[0].index,
            matchType: "unique video-tile signature",
          };
        }

        // Last resort: a media URL is safe only if it uniquely identifies
        // one video tile.
        if (target.src) {
          const sourceMatches = meta
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.sources.includes(target.src));

          if (sourceMatches.length === 1) {
            return {
              index: sourceMatches[0].index,
              matchType: "unique video media source",
            };
          }
        }

        return {
          index: -1,
          matchType: "no unique video-tile match",
        };
      },
      {
        signature: generatedAsset.signature,
        src: generatedAsset.src,
        domIndex: generatedAsset.domIndex,
      },
    )
    .catch(() => ({
      index: -1,
      matchType: "video-tile lookup failed",
    }));

  if (matches.index < 0) {
    await captureFlowDiagnostics(page, "download-video-card-match-failed");

    throw new Error(
      "Could not uniquely identify the generated video card. " +
        "Refusing to click another card's three-dot menu.",
    );
  }

  const videoTile = videoTilesLocator.nth(matches.index);

  if (!(await videoTile.isVisible().catch(() => false))) {
    await captureFlowDiagnostics(page, "download-video-card-not-visible");

    throw new Error(
      "The identified video card is not visible. Download stopped safely.",
    );
  }

  console.log(
    `   ✅ Matched the generated video card by ${matches.matchType}.`,
  );

  // Resolve the menu within this card's parent container.
  const assetCard = videoTile.locator("xpath=ancestor::flow-tile-container[1]");

  if (
    !(await assetCard.count().catch(() => 0)) ||
    !(await assetCard.isVisible().catch(() => false)) ||
    !(await assetCard
      .locator("flow-video-tile")
      .count()
      .catch(() => 0))
  ) {
    await captureFlowDiagnostics(page, "download-video-card-container-invalid");

    throw new Error(
      "The target card does not contain a visible Flow video tile.",
    );
  }

  // Reveal the controls belonging to THIS asset card.
  await assetCard.scrollIntoViewIfNeeded().catch(() => {});
  await assetCard.hover({ timeout: 8000 });
  await page.waitForTimeout(400);

  const moreButton = await findVisibleLocator(
    assetCard,
    [
      "flow-hotbar-container div.hotbar-inner button:has(mat-icon:has-text('more_vert'))",
      "flow-hotbar-container button:has(mat-icon:has-text('more_vert'))",
      'button[aria-label*="More options" i]',
      'button[title*="More options" i]',
      'button[aria-label*="More" i]',
    ],
    { last: false, enabled: true },
  );

  if (!moreButton) {
    await captureFlowDiagnostics(page, "download-asset-more-button-not-found");

    throw new Error(
      "Could not find the three-dot menu on the generated asset card. " +
        "No project-level menu was clicked.",
    );
  }

  console.log("   ⋮ Opening the generated clip's own three-dot menu...");
  await moreButton.click({ timeout: 8000 });
  await page.waitForTimeout(350);

  // Flow's asset menu contains Download. The separate project menu is never used.
  const downloadAction = await findVisibleLocator(
    page,
    [
      'div.mat-mdc-menu-content flow-menu-item button[role="menuitem"]:has(mat-icon:has-text("download"))',
      'div.mat-mdc-menu-content flow-menu-item button[role="menuitem"]:has-text("Download")',
      'div.mat-mdc-menu-content [role="menuitem"]:has-text("Download")',
    ],
    { last: false, enabled: true },
  );

  if (!downloadAction) {
    await captureFlowDiagnostics(page, "download-asset-menu-item-not-found");

    throw new Error(
      "The generated asset menu opened, but its Download action was not found.",
    );
  }

  // Select Download and allow for either a direct download
  // or a resolution submenu to appear.
  const directDownloadPromise = page
    .waitForEvent("download", { timeout: 2000 })
    .catch(() => null);

  await downloadAction.click({ timeout: 8000 });

  const directDownload = await directDownloadPromise;

  if (directDownload) {
    console.log(
      `   ⬇️ Flow started a direct asset download: ${directDownload.suggestedFilename()}`,
    );

    await savePlaywrightDownload(directDownload, destinationPath);

    return true;
  }

  // Wait for Flow's resolution submenu to become visible.
  const resolutionOption = await waitForFlowResolutionOption(
    page,
    resolution,
    12000,
  );

  if (!resolutionOption) {
    const visibleMenus = await page
      .locator("div.mat-mdc-menu-content")
      .evaluateAll((menus) =>
        menus
          .filter((menu) => {
            const rect = menu.getBoundingClientRect();
            const style = window.getComputedStyle(menu);

            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          })
          .map((menu) =>
            String(menu.innerText || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 500),
          ),
      )
      .catch(() => []);

    console.error(
      "   ⚠️ Visible Flow menus after selecting Download:",
      JSON.stringify(visibleMenus),
    );

    await captureFlowDiagnostics(page, "download-720p-option-not-found");

    throw new Error(
      `The asset Download menu did not expose ${resolution} within 12 seconds. ` +
        "Check the visible-menu log and the saved Flow diagnostics.",
    );
  }

  console.log(`   ⬇️ Selecting ${resolution} for the generated video...`);

  const saved = await clickAndSaveIfDownloadStarts(
    page,
    resolutionOption,
    destinationPath,
    FLOW_DOWNLOAD_TIMEOUT_MS,
  );

  if (!saved) {
    await captureFlowDiagnostics(
      page,
      `download-${resolution}-event-not-detected`,
    );

    throw new Error(
      `The ${resolution} option was clicked, but no browser download event was observed.`,
    );
  }

  return true;
}

async function uploadIngredientToFlow(page, imagePath, label) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(
      `${label} image does not exist: ${imagePath || "(missing path)"}`,
    );
  }

  console.log(`   📸 Uploading ${label}: ${path.basename(imagePath)}`);

  // Open the ingredients menu.
  const addIngredientsButton = await findVisibleLocator(
    page,
    [
      'button[aria-label="Add ingredients to the prompt box"]',
      'button[aria-label*="Add ingredients" i]',
      'button:has-text("Add ingredients")',
    ],
    { last: true, enabled: true },
  );

  if (!addIngredientsButton) {
    throw new Error(
      `Could not find Flow's Add ingredients button for ${label}.`,
    );
  }

  await addIngredientsButton.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  // Select Upload media from the ingredients menu.
  const uploadMediaButton = await findVisibleLocator(
    page,
    [
      'button[aria-label="Upload media"]',
      'button:has-text("Upload media")',
      '[role="button"]:has-text("Upload media")',
    ],
    { last: true, enabled: true },
  );

  if (!uploadMediaButton) {
    throw new Error(`Flow's Upload media option was not found for ${label}.`);
  }

  await uploadMediaButton.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  // Upload this image.
  const fileInput = page.locator('input[type="file"]');

  await fileInput.last().waitFor({
    state: "attached",
    timeout: 15000,
  });

  await fileInput.last().setInputFiles(imagePath);

  // Wait for Flow to process the uploaded image.
  const panel = page.locator("flow-add-menu-detail-pane");

  const addToPromptButton = panel.getByRole("button", {
    name: "Add to prompt",
  });

  await addToPromptButton.first().waitFor({
    state: "visible",
    timeout: 30000,
  });

  const loadingPreview = panel.locator('[aria-label="Loading preview"]');

  if (await loadingPreview.count()) {
    await loadingPreview
      .first()
      .waitFor({
        state: "hidden",
        timeout: 30000,
      })
      .catch(() => {});
  }

  // Wait until the image can be added to the prompt.
  let enabled = false;

  for (let attempt = 0; attempt < 60; attempt++) {
    if (await addToPromptButton.first().isEnabled()) {
      enabled = true;
      break;
    }

    await page.waitForTimeout(500);
  }

  if (!enabled) {
    throw new Error(
      `Flow did not enable Add to prompt for ${label} within 30 seconds.`,
    );
  }

  await addToPromptButton.first().click({ timeout: 10000 });
  await page.waitForTimeout(800);

  console.log(`   ✅ Added ${label} to the prompt.`);
}

async function ensureFlowSettingsPanel(page) {
  const panel = page.locator("flow-prompt-box-settings");

  if (await panel.isVisible().catch(() => false)) {
    return panel;
  }

  const trigger = await findVisibleLocator(
    page,
    [
      "flow-base-prompt-box div.submit-controls button.settings-trigger-button",
      "button.settings-trigger-button",
    ],
    { last: false, enabled: true },
  );

  if (!trigger) {
    await captureFlowDiagnostics(page, "missing-generation-settings");
    throw new Error("Cannot find Google Flow generation settings.");
  }

  await trigger.click({ timeout: 10000 });
  await panel.waitFor({ state: "visible", timeout: 10000 });

  return panel;
}

async function getFlowSelectedState(locator) {
  return locator.evaluate((element) => {
    const nodes = [
      element,
      element.closest("mat-button-toggle"),
      element.closest('[role="radio"]'),
      element.closest('[role="option"]'),
    ].filter(Boolean);

    let hasStateSignal = false;

    for (const node of nodes) {
      for (const attribute of [
        "aria-pressed",
        "aria-checked",
        "aria-selected",
      ]) {
        const value = node.getAttribute(attribute);

        if (value === "true") return true;
        if (value === "false") hasStateSignal = true;
      }

      if (
        node.classList.contains("mat-button-toggle-checked") ||
        node.classList.contains("mdc-radio--selected") ||
        node.classList.contains("selected") ||
        node.classList.contains("active")
      ) {
        return true;
      }
    }

    return hasStateSignal ? false : null;
  });
}

async function ensureFlowControlSelected(page, selectors, label) {
  const control = await findVisibleLocator(page, selectors, {
    last: false,
    enabled: true,
  });

  if (!control) {
    await captureFlowDiagnostics(page, `missing-setting-${label}`);

    throw new Error(
      `Flow setting "${label}" was not found. Generation stopped.`,
    );
  }

  let state = await getFlowSelectedState(control).catch(() => null);

  if (state !== true) {
    await control.click({ timeout: 10000 });
    await page.waitForTimeout(400);
    state = await getFlowSelectedState(control).catch(() => null);
  }

  if (state !== true) {
    await captureFlowDiagnostics(page, `unverified-setting-${label}`);

    throw new Error(
      `Could not verify that Flow setting "${label}" is selected. ` +
        "Generation stopped to avoid using the wrong configuration.",
    );
  }

  console.log(`   ✅ Verified Flow setting: ${label}`);
}

async function ensureFlowVideoConfiguration(page) {
  console.log("\n⚙️ Enforcing required Google Flow configuration...");

  await ensureFlowSettingsPanel(page);

  // 1. Switch from Image generation to Video generation.
  await ensureFlowControlSelected(
    page,
    [
      'flow-prompt-box-settings mat-button-toggle:has(mat-icon:has-text("videocam")) button',
      'mat-button-toggle:has(mat-icon:has-text("videocam")) button',
    ],
    "Video",
  );

  // Mode changes can refresh the settings panel.
  await ensureFlowSettingsPanel(page);

  // 2. Choose the exact model.
  let modelDisplay = page.locator(
    "flow-prompt-box-settings span.model-select-trigger-content",
  );

  let currentModel = (
    await modelDisplay
      .first()
      .innerText()
      .catch(() => "")
  ).trim();

  if (!/Omni 1\.1 Flash/i.test(currentModel)) {
    const modelDropdown = await findVisibleLocator(
      page,
      [
        "flow-prompt-box-settings div.settings-content button:has(span.model-select-trigger-content)",
        "flow-prompt-box-settings button:has(span.model-select-trigger-content)",
      ],
      { last: false, enabled: true },
    );

    if (!modelDropdown) {
      await captureFlowDiagnostics(page, "missing-model-dropdown");
      throw new Error("Cannot find Flow's model selector.");
    }

    await modelDropdown.click({ timeout: 10000 });
    await page.waitForTimeout(300);

    const modelOption = await findVisibleLocator(
      page,
      [
        'div.mat-mdc-menu-content flow-menu-item button[role="menuitem"]:has-text("Omni 1.1 Flash")',
        '[role="menuitem"]:has-text("Omni 1.1 Flash")',
      ],
      { last: false, enabled: true },
    );

    if (!modelOption) {
      await captureFlowDiagnostics(page, "missing-omni-11-flash");
      throw new Error("Flow does not expose the Omni 1.1 Flash option.");
    }

    await modelOption.click({ timeout: 10000 });
    await page.waitForTimeout(500);
  }

  modelDisplay = page.locator(
    "flow-prompt-box-settings span.model-select-trigger-content",
  );

  currentModel = (
    await modelDisplay
      .first()
      .innerText()
      .catch(() => "")
  ).trim();

  if (!/Omni 1\.1 Flash/i.test(currentModel)) {
    await captureFlowDiagnostics(page, "model-selection-not-verified");
    throw new Error(
      `Required model is Omni 1.1 Flash, but Flow displays "${currentModel}".`,
    );
  }

  console.log("   ✅ Verified Flow model: Omni 1.1 Flash");

  await ensureFlowSettingsPanel(page);

  // 3. Select Ingredients mode, not Frames mode.
  await ensureFlowControlSelected(
    page,
    [
      'flow-prompt-box-settings mat-button-toggle:has(mat-icon:has-text("chrome_extension")) button',
      'mat-button-toggle:has(mat-icon:has-text("chrome_extension")) button',
    ],
    "Ingredients",
  );

  // 4. Set vertical 9:16 aspect ratio.
  await ensureFlowControlSelected(
    page,
    [
      'flow-prompt-box-settings mat-button-toggle:has(mat-icon:has-text("crop_9_16")) button',
      'mat-button-toggle:has(mat-icon:has-text("crop_9_16")) button',
      'flow-prompt-box-settings mat-button-toggle:has-text("9:16") button',
    ],
    "9:16",
  );

  // 5. Set 720p quality.
  await ensureFlowControlSelected(
    page,
    [
      'flow-prompt-box-settings mat-button-toggle:has-text("720p") button',
      'flow-prompt-box-settings button:has-text("720p")',
      'flow-prompt-box-settings [role="button"]:has-text("720p")',
    ],
    "720p",
  );

  // 6. Set duration to exactly four seconds.
  await ensureFlowControlSelected(
    page,
    [
      'flow-prompt-box-settings mat-button-toggle:has-text("4s") button',
      'flow-prompt-box-settings button:has-text("4s")',
      'flow-prompt-box-settings [role="button"]:has-text("4s")',
    ],
    "4s",
  );

  // 7. Set exactly one output.
  await ensureFlowControlSelected(
    page,
    [
      'flow-prompt-box-settings mat-button-toggle:has-text("x1") button',
      'flow-prompt-box-settings button:has-text("x1")',
      'flow-prompt-box-settings [role="button"]:has-text("x1")',
    ],
    "x1",
  );

  console.log("✅ All required Flow settings were selected and verified.");

  // Close settings so they do not obstruct the ingredient controls.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

async function generateClipsInFlow(tasks) {
  console.log("\n🚀 Launching Chrome with your saved .bot-profile...");
  const useHeadless = process.env.HEADLESS_FLOW === "true";
  const context = await chromium.launchPersistentContext(DIRS.profile, {
    channel: "chrome",
    headless: useHeadless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
    viewport: null,
    acceptDownloads: true,
  });
  const generatedClipPaths = [];
  try {
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    console.log(`🌐 Navigating to Google Flow (${FLOW_URL})...`);
    await page.goto(FLOW_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(5000);
    const startBtn = await findVisibleLocator(
      page,
      [
        'button:has-text("New project")',
        'button:has-text("Create project")',
        'a:has-text("Launch Flow")',
      ],
      { last: false },
    );
    if (startBtn) {
      await startBtn.click();
      await page.waitForTimeout(3500);
    }
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const clipIndex = i + 1;
      const clipDest = path.join(DIRS.clips, `clip_${clipIndex}.mp4`);
      if (!task.imagePath || !fs.existsSync(task.imagePath))
        throw new Error(
          `Reference image for clip ${clipIndex} does not exist: ${task.imagePath || "(missing path)"}`,
        );
      if (!task.prompt || !String(task.prompt).trim())
        throw new Error(`Prompt for clip ${clipIndex} is empty.`);
      fs.rmSync(clipDest, { force: true });
      copyToWindowsClipboard(task.prompt);
      console.log("\n------------------------------------------------------");
      console.log(
        `🎬 CLIP [${clipIndex}/${tasks.length}]: ${String(task.title || `Dress ${clipIndex}`).slice(0, 70)}`,
      );
      console.log(`📸 Ingredient Image: ${task.imagePath}`);
      console.log(`📋 Prompt: "${String(task.prompt).slice(0, 100)}..."`);
      console.log("------------------------------------------------------");
      try {
        // Force and verify Video + Ingredients + required preferences first.
        await ensureFlowVideoConfiguration(page);

        // Image 1: the dress reference with the original face blurred.
        await uploadIngredientToFlow(page, task.imagePath, "dress reference");

        // Image 2: your fixed AI influencer character.
        await uploadIngredientToFlow(
          page,
          task.characterImagePath || CHARACTER_IMAGE_PATH,
          "fixed character reference",
        );
        await page.waitForTimeout(1000);

        await page.waitForTimeout(1800);
        const promptBox = await findVisibleLocator(
          page,
          [
            "textarea:not(.g-recaptcha-response)",
            '[contenteditable="true"]:visible',
          ],
          { last: true },
        );
        if (!promptBox) {
          await captureFlowDiagnostics(page, `clip-${clipIndex}-no-prompt-box`);
          throw new Error("Could not find a visible Flow prompt box.");
        }
        await promptBox.click();
        await promptBox.fill(String(task.prompt));
        console.log("   ✍️ Filled prompt successfully.");
        await page.waitForTimeout(500);
        const baseline = await getFlowMediaSnapshot(page);
        const submitButton = await findVisibleLocator(
          page,
          [
            "flow-generate-icon-button button.generate-icon-button",
            'flow-generate-icon-button button:has(mat-icon:has-text("arrow_forward"))',
            'button[aria-label*="Submit" i]',
            'button[aria-label*="Generate" i]',
            'button[aria-label*="Create" i]',
            'button[type="submit"]',
          ],
          { last: true, enabled: true },
        );
        if (submitButton) await submitButton.click();
        else
          await promptBox.press("Control+Enter").catch(async () => {
            await page.keyboard.press("Enter");
          });
        console.log("   ⚡ Submitted clip generation.");
        const generatedMedia = await waitForNewGeneratedAsset(
          page,
          baseline,
          clipIndex,
        );
        console.log(
          "   ✨ Clip is rendered. Starting the Flow asset download workflow...",
        );
        let downloaded = false;

        try {
          downloaded = await attemptFlowDownload(
            page,
            clipDest,
            "720p",
            generatedMedia.generatedAsset,
          );
        } catch (error) {
          console.warn(`⚠️ 720p download attempt failed: ${error.message}`);
        }

        if (!downloaded) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipIndex}-720p-download-failed`,
          );

          throw new Error(
            `Clip ${clipIndex} was generated, but a 720p download ` +
              "could not be confirmed. Check the Flow diagnostics.",
          );
        }
        if (!downloaded) {
          console.log("   ↪️ Falling back to the standard 720p export...");
          try {
            downloaded = await attemptFlowDownload(page, clipDest, "720p");
          } catch (error) {
            console.warn(
              `   ⚠️ 720p download attempt did not complete: ${error.message}`,
            );
          }
        }
        if (!downloaded) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipIndex}-download-failed`,
          );
          throw new Error(
            `Flow rendered clip ${clipIndex}, but no file download completed. Check the flow-debug JSON and PNG in the output folder. The page may have changed its download menu labels or Flow may not have offered a downloadable file.`,
          );
        }
        generatedClipPaths.push(clipDest);
        console.log(
          `   ✅ Saved Clip ${clipIndex}/${tasks.length} to: ${clipDest}`,
        );
      } catch (error) {
        console.error(`   ❌ Error on Clip ${clipIndex}: ${error.message}`);
        await captureFlowDiagnostics(page, `clip-${clipIndex}-error`).catch(
          () => {},
        );
        throw error;
      }
    }
    return generatedClipPaths;
  } finally {
    await context.close().catch(() => {});
  }
}
function stitchClipsToReel(clipPaths) {
  console.log(
    "\n🎞️ Stitching 5 clips into a 20-second 1080x1920 Reel via FFmpeg...",
  );
  const bin = ffmpegPath || "ffmpeg";
  const finalReelPath = path.join(DIRS.output, `final_reel_${Date.now()}.mp4`);
  const concatListPath = path.join(DIRS.clips, "filelist.txt");
  const normalizedPaths = clipPaths.map((clipPath, idx) => {
    const normPath = path.join(DIRS.clips, `norm_clip_${idx + 1}.mp4`);
    execFileSync(
      bin,
      [
        "-y",
        "-i",
        clipPath,
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p",
        "-t",
        "4",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-an",
        normPath,
      ],
      { stdio: "ignore" },
    );
    return normPath;
  });
  const fileListContent = normalizedPaths
    .map((p) => `file '${p.replace(/\\/g, "/")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, fileListContent, "utf8");
  execFileSync(
    bin,
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      finalReelPath,
    ],
    { stdio: "ignore" },
  );
  console.log(`🎉 20-Second Reel created: ${finalReelPath}`);
  return finalReelPath;
}
(async () => {
  try {
    const selectedJsonPath = path.join(__dirname, "selected_dresses.json");
    if (!fs.existsSync(selectedJsonPath))
      throw new Error(
        "selected_dresses.json not found! Run phase1-scraper-bot.js first.",
      );
    const selectedDresses = JSON.parse(
      fs.readFileSync(selectedJsonPath, "utf8"),
    );
    if (!selectedDresses.length)
      throw new Error("selected_dresses.json is empty.");
    const { videoMode, affiliateTag } = await resolveUserChoices();
    console.log(
      `\n📦 Loaded ${selectedDresses.length} picks | Mode: ${videoMode} | Affiliate Tag: ${affiliateTag}`,
    );
    const captionLinks = [];
    if (videoMode === "OPTION_B") {
      const dress = selectedDresses[0];
      const prodUrl = dress.productUrl || dress.url || dress.link;
      const affUrl = buildAffiliateUrl(prodUrl, dress.asin, affiliateTag);
      captionLinks.push(
        `👗 Featured Outfit (${dress.price || ""}):\n${affUrl}`,
      );
    } else {
      const fiveDresses = selectedDresses.slice(0, 5);
      for (let i = 0; i < fiveDresses.length; i++) {
        const dress = fiveDresses[i];
        const prodUrl = dress.productUrl || dress.url || dress.link;
        const affUrl = buildAffiliateUrl(prodUrl, dress.asin, affiliateTag);
        captionLinks.push(
          `${i + 1}. ${(dress.title || "Amazon Find").slice(0, 38)}... (${dress.price || ""})\n${affUrl}`,
        );
      }
    }
    const prepareImagesOnly =
      (process.env.PREPARE_IMAGES_ONLY || "").trim().toLowerCase() === "true";

    let clips = [1, 2, 3, 4, 5].map((i) =>
      path.join(DIRS.clips, `clip_${i}.mp4`),
    );

    const oneClipTest =
      (process.env.FLOW_TEST_ONE_CLIP || "").trim().toLowerCase() === "true";

    const allClipsExist =
      !prepareImagesOnly &&
      !oneClipTest &&
      clips.every((p) => fs.existsSync(p) && fs.statSync(p).size > 1024);
    if (allClipsExist) {
      console.log(
        '\n✨ Found all 5 clips already generated in your "clips/" folder!',
      );
      console.log(
        "⚡ Skipping Google Flow generation and jumping straight to FFmpeg stitcher...",
      );
    } else {
      const generationTasks = [];
      if (videoMode === "OPTION_B") {
        const dress = selectedDresses[0];
        const localImg = path.join(DIRS.tempImages, "dress_1.jpg");
        const referenceImg = path.join(DIRS.tempImages, "dress_1_faceblur.jpg");
        await downloadImage(
          dress.imageUrl || dress.image || dress.img,
          localImg,
        );

        if (!prepareImagesOnly) {
          const fivePrompts = await generateSilentModelPrompts(
            localImg,
            dress.title || "Festive Dress",
            5,
          );

          for (let i = 0; i < 5; i++) {
            generationTasks.push({
              title: `${dress.title || "Dress"} (Pose ${i + 1})`,
              imagePath: referenceImg,
              prompt: fivePrompts[i] || fivePrompts[0],
            });
          }
        }
      } else {
        const fiveDresses = selectedDresses.slice(0, 5);
        for (let i = 0; i < fiveDresses.length; i++) {
          const dress = fiveDresses[i];

          const localImg = path.join(DIRS.tempImages, `dress_${i + 1}.jpg`);

          const referenceImg = path.join(
            DIRS.tempImages,
            `dress_${i + 1}_faceblur.jpg`,
          );

          await downloadImage(
            dress.imageUrl || dress.image || dress.img,
            localImg,
          );

          await prepareDressReferenceImage(localImg, referenceImg);

          if (prepareImagesOnly) {
            continue;
          }

          const [prompt] = await generateSilentModelPrompts(
            localImg,
            dress.title || `Dress ${i + 1}`,
            1,
          );

          generationTasks.push({
            title: dress.title || `Dress ${i + 1}`,
            imagePath: referenceImg,
            prompt,
          });
        }
      }
      if (prepareImagesOnly) {
        console.log("\n✅ Image preparation completed.");
        console.log(
          `📂 Check the prepared reference images inside: ${DIRS.tempImages}`,
        );
        console.log("🧪 Test-only mode enabled: Google Flow was not launched.");
        return;
      }
      // Step 2.4: Validate the fixed character image before opening Flow.
      if (!fs.existsSync(CHARACTER_IMAGE_PATH)) {
        throw new Error(
          `Fixed character image not found: ${CHARACTER_IMAGE_PATH}. ` +
            "Check CHARACTER_IMAGE_PATH in your .env file.",
        );
      }

      // Attach the same character image path to all five tasks.
      generationTasks.forEach((task) => {
        task.characterImagePath = CHARACTER_IMAGE_PATH;
      });

      console.log(
        `✅ Fixed character image validated: ${CHARACTER_IMAGE_PATH}`,
      );

      // Launch Google Flow only after validation succeeds.
      const tasksToRun = oneClipTest
        ? generationTasks.slice(0, 1)
        : generationTasks;

      clips = await generateClipsInFlow(tasksToRun);

      if (oneClipTest) {
        console.log("\n✅ One-clip test finished. Check clips/clip_1.mp4.");
        console.log(
          "⏭️ Skipping FFmpeg stitching and Telegram delivery for this test.",
        );
        return;
      }
    }
    const finalReel = stitchClipsToReel(clips);
    const caption = `✨ Your 20-Sec AI Influencer Reel is Ready! (${videoMode})\n\n🛍️ Shop the Affiliate Links:\n\n${captionLinks.join("\n\n")}`;
    await sendFinalVideoToTelegram(finalReel, caption);
    console.log(
      '\n🎉 ALL DONE! Check your Telegram Bot or the "output" folder in VS Code.',
    );
  } catch (error) {
    console.error("\n❌ Phase 2 Pipeline Error:", error.message);
    process.exitCode = 1;
  }
})();
