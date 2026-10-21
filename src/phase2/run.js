"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  ROOT,
  DIRS,
  CHARACTER_IMAGE_PATH,
  DEFAULT_AFFILIATE_TAG,
  CLIP_COUNT,
} = require("./config");

const { downloadImage, buildAffiliateUrl } = require("./products");

const {
  prepareDressReferenceImage,
  generateSilentModelPrompts,
} = require("./images");

const { generateClipsInFlow } = require("./flow/generator");
const { stitchClipsToReel } = require("./video");
const { postProcessReel } = require("./postprocess");

// New independent audio module.
const { addBackgroundMusic } = require("./music/audio");

const { sendFinalVideoToTelegram } = require("./telegram");
const { clearGeneratedFolders } = require("./cleanup");
const { resolveUserChoices: resolveConfiguredChoices } = require("./mode");

function resolveUserChoices() {
  const choices = resolveConfiguredChoices(process.env, DEFAULT_AFFILIATE_TAG);

  console.log(`🎥 Reel mode from configuration: ${choices.videoMode}`);

  return choices;
}

function createGenerationSignature(videoMode, products) {
  if (!fs.existsSync(CHARACTER_IMAGE_PATH)) {
    throw new Error(
      `Fixed character image not found: ${CHARACTER_IMAGE_PATH}. ` +
        "Check CHARACTER_IMAGE_PATH in your .env file.",
    );
  }

  const selectedProducts =
    videoMode === "OPTION_B"
      ? products.slice(0, 1)
      : products.slice(0, CLIP_COUNT);

  const characterHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(CHARACTER_IMAGE_PATH))
    .digest("hex");

  const signatureData = JSON.stringify({
    version: 1,
    videoMode,
    clipCount: CLIP_COUNT,
    characterHash,
    selectedProducts: selectedProducts.map((product) => ({
      id: product.id,
      asin: product.asin,
      title: product.title,
      imageUrl: product.imageUrl || product.image || product.img,
    })),
  });

  return crypto.createHash("sha256").update(signatureData).digest("hex");
}

function buildAffiliateCaption(products, videoMode, affiliateTag) {
  const selectedProducts =
    videoMode === "OPTION_B"
      ? products.slice(0, 1)
      : products.slice(0, CLIP_COUNT);

  return selectedProducts.map((product, index) => {
    const productUrl = product.productUrl || product.url || product.link;

    const affiliateUrl = buildAffiliateUrl(
      productUrl,
      product.asin,
      affiliateTag,
    );

    if (videoMode === "OPTION_B") {
      return `👗 Featured Outfit (${product.price || ""}):\n` + affiliateUrl;
    }

    return (
      `${index + 1}. ${(product.title || "Amazon Find").slice(0, 38)}... ` +
      `(${product.price || ""})\n${affiliateUrl}`
    );
  });
}

async function run() {
  try {
    const selectedDressesPath = path.join(ROOT, "selected_dresses.json");

    if (!fs.existsSync(selectedDressesPath)) {
      throw new Error(
        "selected_dresses.json not found! " +
          "Run phase1-scraper-bot.js first.",
      );
    }

    const products = JSON.parse(fs.readFileSync(selectedDressesPath, "utf8"));

    if (!Array.isArray(products) || products.length === 0) {
      throw new Error(
        "selected_dresses.json is empty or is not a valid product array.",
      );
    }

    const { videoMode, affiliateTag } = await resolveUserChoices();

    if (videoMode !== "OPTION_B" && products.length < CLIP_COUNT) {
      throw new Error(
        `CLIP_COUNT is ${CLIP_COUNT}, but only ${products.length} ` +
          "products are selected. Select enough products or lower " +
          "CLIP_COUNT in src/phase2/config.js.",
      );
    }

    console.log(
      `\n📦 Loaded ${products.length} picks | Mode: ${videoMode} | ` +
        `Affiliate Tag: ${affiliateTag}`,
    );

    const affiliateLinks = buildAffiliateCaption(
      products,
      videoMode,
      affiliateTag,
    );

    const prepareImagesOnly =
      String(process.env.PREPARE_IMAGES_ONLY || "")
        .trim()
        .toLowerCase() === "true";

    const oneClipTest =
      String(process.env.FLOW_TEST_ONE_CLIP || "")
        .trim()
        .toLowerCase() === "true";

    let clipPaths = Array.from({ length: CLIP_COUNT }, (_, index) =>
      path.join(DIRS.clips, `clip_${index + 1}.mp4`),
    );

    const manifestPath = path.join(DIRS.clips, ".generation-manifest.json");

    if (oneClipTest) {
      fs.rmSync(manifestPath, { force: true });
    }

    const signature = prepareImagesOnly
      ? null
      : createGenerationSignature(videoMode, products);

    let manifestMatches = false;

    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

        manifestMatches =
          Boolean(signature) &&
          manifest.version === 1 &&
          manifest.signature === signature;
      } catch (error) {
        console.warn(
          `⚠️ Ignoring invalid clip-generation manifest: ${error.message}`,
        );
      }
    }

    const allClipsExist = clipPaths.every(
      (clipPath) =>
        fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1024,
    );

    if (
      !prepareImagesOnly &&
      !oneClipTest &&
      manifestMatches &&
      allClipsExist
    ) {
      console.log(
        `\n✨ Found all ${CLIP_COUNT} clips already generated in your "clips/" folder!`,
      );

      console.log(
        "⚡ Skipping Google Flow generation and jumping straight to FFmpeg stitcher...",
      );
    } else {
      const generationItems = [];

      if (videoMode === "OPTION_B") {
        const product = products[0];

        const dressPath = path.join(DIRS.tempImages, "dress_1.jpg");

        const faceBlurPath = path.join(DIRS.tempImages, "dress_1_faceblur.jpg");

        await downloadImage(
          product.imageUrl || product.image || product.img,
          dressPath,
        );

        await prepareDressReferenceImage(dressPath, faceBlurPath);

        if (!prepareImagesOnly) {
          const promptCount = oneClipTest ? 1 : CLIP_COUNT;

          const prompts = await generateSilentModelPrompts(
            dressPath,
            product.title || "Festive Dress",
            promptCount,
          );

          for (let index = 0; index < promptCount; index += 1) {
            generationItems.push({
              title: `${product.title || "Dress"} (Pose ${index + 1})`,
              imagePath: faceBlurPath,
              prompt: prompts[index] || prompts[0],
            });
          }
        }
      } else {
        const selectedProducts = products.slice(
          0,
          oneClipTest ? 1 : CLIP_COUNT,
        );

        for (let index = 0; index < selectedProducts.length; index += 1) {
          const product = selectedProducts[index];

          const dressPath = path.join(
            DIRS.tempImages,
            `dress_${index + 1}.jpg`,
          );

          const faceBlurPath = path.join(
            DIRS.tempImages,
            `dress_${index + 1}_faceblur.jpg`,
          );

          await downloadImage(
            product.imageUrl || product.image || product.img,
            dressPath,
          );

          await prepareDressReferenceImage(dressPath, faceBlurPath);

          if (prepareImagesOnly) {
            continue;
          }

          const [prompt] = await generateSilentModelPrompts(
            dressPath,
            product.title || `Dress ${index + 1}`,
            1,
          );

          generationItems.push({
            title: product.title || `Dress ${index + 1}`,
            imagePath: faceBlurPath,
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

      if (!fs.existsSync(CHARACTER_IMAGE_PATH)) {
        throw new Error(
          `Fixed character image not found: ${CHARACTER_IMAGE_PATH}. ` +
            "Check CHARACTER_IMAGE_PATH in your .env file.",
        );
      }

      for (const item of generationItems) {
        item.characterImagePath = CHARACTER_IMAGE_PATH;
      }

      console.log(
        `✅ Fixed character image validated: ${CHARACTER_IMAGE_PATH}`,
      );

      const generationBatch = oneClipTest
        ? generationItems.slice(0, 1)
        : generationItems;

      clipPaths = await generateClipsInFlow(generationBatch);

      if (oneClipTest) {
        console.log("\n✅ One-clip test finished. Check clips/clip_1.mp4.");

        console.log(
          "⏭️ Skipping FFmpeg stitching and Telegram delivery for this test.",
        );

        return;
      }

      const generatedClipsAreValid =
        clipPaths.length === CLIP_COUNT &&
        clipPaths.every(
          (clipPath) =>
            fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1024,
        );

      if (generatedClipsAreValid) {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              version: 1,
              signature,
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    }

    // Existing step 1: stitch the generated clips.
    const stitchedVideoPath = stitchClipsToReel(clipPaths);

    const selectedProducts =
      videoMode === "OPTION_B"
        ? products.slice(0, 1)
        : products.slice(0, CLIP_COUNT);

    // Existing step 2: apply the working text overlay.
    const processed = await postProcessReel(stitchedVideoPath, {
      products: selectedProducts,
      videoMode,
    });

    // New step 3: independently generate and mix background music.
    // Failure inside this module falls back to the processed video.
    const musicResult = await addBackgroundMusic(processed.videoPath, {
      category: processed.category,
      products: selectedProducts,
      videoMode,
    });

    const finalVideoPath = musicResult.videoPath;

    console.log(`🎵 Background music result: ${musicResult.source}`);

    // Existing Telegram caption and affiliate links.
    const telegramCaption =
      `✨ Your 20-Sec AI Influencer Reel is Ready! (${videoMode})\n` +
      `🎬 Style: ${processed.category.toUpperCase()}\n\n` +
      `🛍️ Shop the Affiliate Links:\n\n` +
      affiliateLinks.join("\n\n");

    // Only the video path changes: send the final music-enhanced video.
    const delivered = await sendFinalVideoToTelegram(
      finalVideoPath,
      telegramCaption,
    );

    const cleanupAfterDelivery = !["false", "0", "no", "off"].includes(
      String(process.env.CLEANUP_AFTER_DELIVERY || "true")
        .trim()
        .toLowerCase(),
    );

    if (delivered && cleanupAfterDelivery) {
      clearGeneratedFolders([DIRS.clips, DIRS.output, DIRS.tempImages]);

      console.log(
        "🧹 Cleared clips, output, and temp_images after Telegram delivery.",
      );
    } else if (delivered) {
      console.log(
        "ℹ️ Keeping generated files; CLEANUP_AFTER_DELIVERY is disabled.",
      );
    }

    console.log(
      '\n🎉 ALL DONE! Check your Telegram Bot or the "output" folder in VS Code.',
    );
  } catch (error) {
    console.error("\n❌ Phase 2 Pipeline Error:", error.message);

    process.exitCode = 1;
  }
}

module.exports = { run };
