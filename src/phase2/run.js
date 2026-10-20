const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT, DIRS, CHARACTER_IMAGE_PATH, DEFAULT_AFFILIATE_TAG } = require("./config");
const { downloadImage, buildAffiliateUrl } = require("./products");
const { prepareDressReferenceImage, generateSilentModelPrompts } = require("./images");
const { generateClipsInFlow } = require("./flow/generator");
const { stitchClipsToReel } = require("./video");
const { sendFinalVideoToTelegram } = require("./telegram");
const { resolveUserChoices: resolveConfiguredChoices } = require("./mode");

function resolveUserChoices() {
  const choices = resolveConfiguredChoices(process.env, DEFAULT_AFFILIATE_TAG);
  console.log(`🎥 Reel mode from configuration: ${choices.videoMode}`);
  return choices;
}

function createGenerationSignature(videoMode, selectedDresses) {
  if (!fs.existsSync(CHARACTER_IMAGE_PATH)) {
    throw new Error(
      `Fixed character image not found: ${CHARACTER_IMAGE_PATH}. ` +
        "Check CHARACTER_IMAGE_PATH in your .env file.",
    );
  }

  const selectedProducts =
    videoMode === "OPTION_B" ? selectedDresses.slice(0, 1) : selectedDresses.slice(0, 5);
  const characterHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(CHARACTER_IMAGE_PATH))
    .digest("hex");
  const signatureData = JSON.stringify({
    version: 1,
    videoMode,
    characterHash,
    selectedProducts: selectedProducts.map((dress) => ({
      id: dress.id,
      asin: dress.asin,
      title: dress.title,
      imageUrl: dress.imageUrl || dress.image || dress.img,
    })),
  });

  return crypto.createHash("sha256").update(signatureData).digest("hex");
}

async function run() {
  try {
      const selectedJsonPath = path.join(ROOT, "selected_dresses.json");
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

      const manifestPath = path.join(DIRS.clips, ".generation-manifest.json");
      if (oneClipTest) fs.rmSync(manifestPath, { force: true });
      const expectedSignature = prepareImagesOnly
        ? null
        : createGenerationSignature(videoMode, selectedDresses);
      let manifestMatches = false;
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          manifestMatches = Boolean(expectedSignature) &&
            manifest.version === 1 &&
            manifest.signature === expectedSignature;
        } catch (error) {
          console.warn(
            `⚠️ Ignoring invalid clip-generation manifest: ${error.message}`,
          );
        }
      }
      const allClipsExist =
        !prepareImagesOnly &&
        !oneClipTest &&
        manifestMatches &&
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
          await prepareDressReferenceImage(localImg, referenceImg);

          if (!prepareImagesOnly) {
            const promptCount = oneClipTest ? 1 : 5;
            const fivePrompts = await generateSilentModelPrompts(
              localImg,
              dress.title || "Festive Dress",
              promptCount,
            );

            for (let i = 0; i < promptCount; i++) {
              generationTasks.push({
                title: `${dress.title || "Dress"} (Pose ${i + 1})`,
                imagePath: referenceImg,
                prompt: fivePrompts[i] || fivePrompts[0],
              });
            }
          }
        } else {
          const fiveDresses = selectedDresses.slice(0, oneClipTest ? 1 : 5);
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
        if (
          clips.length === 5 &&
          clips.every((clipPath) => fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1024)
        ) {
          fs.writeFileSync(
            manifestPath,
            JSON.stringify(
              { version: 1, signature: expectedSignature },
              null,
              2,
            ),
            "utf8",
          );
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
}

module.exports = { run };
