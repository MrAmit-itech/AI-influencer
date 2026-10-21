const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { GEMINI_API_KEY } = require("./config");
const GEMINI_VIDEO_PROMPT_PATH = path.join(
  __dirname,
  "flow",
  "gemini-video-prompt.txt",
);

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
  const promptInstruction = fs
    .readFileSync(GEMINI_VIDEO_PROMPT_PATH, "utf8")
    .replace(/\{\{dressTitle\}\}/g, () => dressTitle)
    .replace(/\{\{count\}\}/g, () => String(count))
    .trim();
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

module.exports = { prepareDressReferenceImage, generateSilentModelPrompts };
