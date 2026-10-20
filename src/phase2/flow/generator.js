const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { chromium } = require("playwright");

const {
  DIRS,
  FLOW_URL,
  CHARACTER_IMAGE_PATH,
  FLOW_GENERATION_TIMEOUT_MS,
} = require("../config");

const {
  captureFlowDiagnostics,
  findVisibleLocator,
  getFlowMediaSnapshot,
} = require("./page");

const {
  waitForNewGeneratedAsset,
  attemptFlowDownload,
} = require("./assets");

const { FLOW_VIDEO_SETTINGS } = require("./config");

const {
  uploadIngredientToFlow,
  resetFlowPromptIngredients,
  waitForIngredientAttachedToPrompt,
  ensureFlowVideoConfiguration,
  getAttachedIngredientSources,
  reuseUploadedIngredientInFlow,
} = require("./ingredients");

function copyToWindowsClipboard(text) {
  try {
    spawnSync("clip", [], {
      input: text,
      encoding: "utf8",
    });
  } catch {
    // Clipboard access is optional; generation can continue.
  }
}

async function generateClipsInFlow(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(
      "No clip-generation tasks were provided to Google Flow."
    );
  }

  console.log(
    "\n🚀 Launching Chrome with your saved .bot-profile..."
  );

  const headless = process.env.HEADLESS_FLOW === "true";

  const context = await chromium.launchPersistentContext(
    DIRS.profile,
    {
      channel: "chrome",
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
      ],
      viewport: null,
      acceptDownloads: true,
    }
  );

  const completedClipPaths = [];

  /*
   * Maps a downloaded file's SHA-256 hash to its original clip number.
   * This catches byte-for-byte duplicate MP4 downloads.
   */
  const clipHashes = new Map();

  try {
    const page = context.pages()[0] || await context.newPage();

    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);

    console.log(`🌐 Navigating to Google Flow (${FLOW_URL})...`);

    await page.goto(FLOW_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);

    const newProjectButton = await findVisibleLocator(
      page,
      [
        'button:has-text("New project")',
        'button:has-text("Create project")',
        'a:has-text("Launch Flow")',
      ],
      { last: false }
    );

    if (newProjectButton) {
      await newProjectButton.click();
      await page.waitForTimeout(3500);
    }

    const ingredientControl = page
      .locator(
        'button[aria-label="Add ingredients to the prompt box"]'
      )
      .last();

    try {
      await ingredientControl.waitFor({
        state: "visible",
        timeout: 60000,
      });
    } catch (error) {
      await captureFlowDiagnostics(
        page,
        "flow-prompt-not-ready"
      );

      throw new Error(
        "Google Flow did not expose its prompt ingredient control " +
          `after navigation: ${error.message}`
      );
    }

    const characterImagePath =
      tasks[0]?.characterImagePath || CHARACTER_IMAGE_PATH;

    if (
      !characterImagePath ||
      !fs.existsSync(characterImagePath)
    ) {
      throw new Error(
        `Fixed character image not found: ${
          characterImagePath || "(missing path)"
        }.`
      );
    }

    await ensureFlowVideoConfiguration(page);

    await uploadIngredientToFlow(
      page,
      characterImagePath,
      "Miss_Rashi character reference"
    );

    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const clipNumber = index + 1;
      const outputPath = path.join(
        DIRS.clips,
        `clip_${clipNumber}.mp4`
      );

      if (
        !task.imagePath ||
        !fs.existsSync(task.imagePath)
      ) {
        throw new Error(
          `Reference image for clip ${clipNumber} does not exist: ${
            task.imagePath || "(missing path)"
          }`
        );
      }

      if (!task.prompt || !String(task.prompt).trim()) {
        throw new Error(
          `Prompt for clip ${clipNumber} is empty.`
        );
      }

      const taskCharacterPath =
        task.characterImagePath || characterImagePath;

      if (
        path.resolve(taskCharacterPath) !==
        path.resolve(characterImagePath)
      ) {
        throw new Error(
          `Clip ${clipNumber} uses a different character image. ` +
            "All clips must use the same character reference."
        );
      }

      fs.rmSync(outputPath, { force: true });

      const prompt =
        `Use the exact same woman shown in the ${path.basename(
          characterImagePath
        )} character reference. Preserve her face and identity; do not generate a different person. The dress reference controls clothing only.\n\n` +
        String(task.prompt).trim();

      copyToWindowsClipboard(prompt);

      console.log("\n------------------------------------------------------");
      console.log(
        `🎬 CLIP [${clipNumber}/${tasks.length}]: ${String(
          task.title || `Dress ${clipNumber}`
        ).slice(0, 70)}`
      );
      console.log(`📸 Ingredient Image: ${task.imagePath}`);
      console.log(`📋 Prompt: "${prompt.slice(0, 100)}..."`);
      console.log("------------------------------------------------------");

      try {
        await ensureFlowVideoConfiguration(page);

        if (index > 0) {
          await resetFlowPromptIngredients(page);

          await reuseUploadedIngredientInFlow(
            page,
            characterImagePath,
            "Miss_Rashi character reference"
          );
        }

        await uploadIngredientToFlow(
          page,
          task.imagePath,
          "dress reference"
        );

        await waitForIngredientAttachedToPrompt(
          page,
          task.imagePath,
          "dress reference"
        );

        await waitForIngredientAttachedToPrompt(
          page,
          characterImagePath,
          "Miss_Rashi character reference"
        );

        const attachedSources =
          await getAttachedIngredientSources(page);

        if (attachedSources.length !== 2) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipNumber}-unexpected-reference-count`
          );

          throw new Error(
            `Clip ${clipNumber}: expected exactly two image references ` +
              `(character and dress), but found ${attachedSources.length}. ` +
              "Generation stopped."
          );
        }

        console.log(
          "   ✅ Verified two image references before prompt submission."
        );

        const promptBox = await findVisibleLocator(
          page,
          [
            "textarea:not(.g-recaptcha-response)",
            '[contenteditable="true"]:visible',
          ],
          { last: true }
        );

        if (!promptBox) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipNumber}-no-prompt-box`
          );

          throw new Error(
            "Could not find a visible Flow prompt box."
          );
        }

        await promptBox.click();
        await promptBox.fill(prompt);

        console.log("   ✍️ Filled prompt successfully.");

        await waitForIngredientAttachedToPrompt(
          page,
          task.imagePath,
          "dress reference"
        );

        await waitForIngredientAttachedToPrompt(
          page,
          characterImagePath,
          "Miss_Rashi character reference"
        );

        /*
         * Keep the existing preview pause exactly as requested.
         */
        console.log(
          "   👀 Both images and prompt are ready. " +
            "Waiting 3 seconds before generation..."
        );

        await page.waitForTimeout(3000);

        /*
         * Capture the baseline immediately before submission.
         * New-video detection compares later cards against this snapshot.
         */
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
          {
            last: true,
            enabled: true,
          }
        );

        if (submitButton) {
          await submitButton.click();
        } else {
          await promptBox
            .press("Control+Enter")
            .catch(async () => {
              await page.keyboard.press("Enter");
            });
        }

        console.log("   ⚡ Submitted clip generation.");

        const generatedResult =
          await waitForNewGeneratedAsset(
            page,
            baseline,
            clipNumber
          );

        const generatedAsset = generatedResult.generatedAsset;

        console.log(
          `   ✅ New video card identified for clip ${clipNumber}.`
        );

        console.log(
          `   🔑 Video card identity: ${generatedAsset.signature}`
        );

        console.log(
          "   ✨ Clip is rendered. Starting the Flow asset download workflow..."
        );

        let downloaded = false;

        try {
          downloaded = await attemptFlowDownload(
            page,
            outputPath,
            FLOW_VIDEO_SETTINGS.resolution,
            generatedAsset
          );
        } catch (error) {
          console.warn(
            `⚠️ ${FLOW_VIDEO_SETTINGS.resolution} download attempt failed: ` +
              error.message
          );
        }

        if (!downloaded) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipNumber}-${FLOW_VIDEO_SETTINGS.resolution}-download-failed`
          );

          throw new Error(
            `Clip ${clipNumber} was generated, but a ` +
              `${FLOW_VIDEO_SETTINGS.resolution} download could not be confirmed. ` +
              "Check the Flow diagnostics."
          );
        }

        /*
         * Duplicate guard: if Flow/downloads returns the exact same
         * MP4 bytes as a previous clip, stop instead of silently
         * including a duplicate in the final Reel.
         */
        const fileHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(outputPath))
          .digest("hex");

        const previousClipNumber = clipHashes.get(fileHash);

        if (previousClipNumber !== undefined) {
          fs.rmSync(outputPath, { force: true });

          throw new Error(
            `Clip ${clipNumber} downloaded byte-for-byte identical ` +
              `MP4 content to clip ${previousClipNumber}. ` +
              "The duplicate file was rejected and the pipeline stopped. " +
              "Check the selected Flow asset and its download."
          );
        }

        clipHashes.set(fileHash, clipNumber);
        completedClipPaths.push(outputPath);

        console.log(
          `   ✅ Saved Clip ${clipNumber}/${tasks.length} to: ${outputPath}`
        );
      } catch (error) {
        console.error(
          `   ❌ Error on Clip ${clipNumber}: ${error.message}`
        );

        await captureFlowDiagnostics(
          page,
          `clip-${clipNumber}-error`
        ).catch(() => {});

        throw error;
      }
    }

    return completedClipPaths;
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  generateClipsInFlow,
};