"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  DIRS,
  CLIP_COUNT,
  CHARACTER_IMAGE_PATH,
} = require("../config");
const { downloadImage } = require("../products");
const {
  prepareDressReferenceImage,
  generateSilentModelPrompts,
} = require("../images");
const { generateClipsInFlow } = require("../flow/generator");

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

async function generateClipSet({
  products,
  videoMode,
  prepareImagesOnly,
  oneClipTest,
}) {
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

  if (!prepareImagesOnly && !oneClipTest && manifestMatches && allClipsExist) {
    console.log(
      `\n✨ Found all ${CLIP_COUNT} clips already generated in your "clips/" folder!`,
    );
    console.log(
      "⚡ Skipping Google Flow generation and jumping straight to FFmpeg stitcher...",
    );

    return {
      clipPaths,
      manifestPath,
      signature,
      skippedGeneration: true,
      prepareImagesOnly: false,
      oneClipTest: false,
    };
  }

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
      const dressPath = path.join(DIRS.tempImages, `dress_${index + 1}.jpg`);
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

    return {
      clipPaths,
      manifestPath,
      signature,
      skippedGeneration: false,
      prepareImagesOnly: true,
      oneClipTest: false,
    };
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

    return {
      clipPaths,
      manifestPath,
      signature,
      skippedGeneration: false,
      prepareImagesOnly: false,
      oneClipTest: true,
    };
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

  return {
    clipPaths,
    manifestPath,
    signature,
    skippedGeneration: false,
    prepareImagesOnly: false,
    oneClipTest: false,
  };
}

module.exports = {
  createGenerationSignature,
  generateClipSet,
};
