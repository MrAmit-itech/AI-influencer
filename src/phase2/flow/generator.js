const fs = require("fs");
const path = require("path");
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
const { waitForNewGeneratedAsset, attemptFlowDownload } = require("./assets");
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
    spawnSync("clip", [], { input: text, encoding: "utf8" });
  } catch {}
}

async function generateClipsInFlow(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("No clip-generation tasks were provided to Google Flow.");
  }

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
    const addIngredientsButton = page
      .locator('button[aria-label="Add ingredients to the prompt box"]')
      .last();
    try {
      await addIngredientsButton.waitFor({
        state: "visible",
        timeout: 60000,
      });
    } catch (error) {
      await captureFlowDiagnostics(page, "flow-prompt-not-ready");
      throw new Error(
        `Google Flow did not expose its prompt ingredient control after navigation: ${error.message}`,
      );
    }

    const characterImagePath =
      tasks[0]?.characterImagePath || CHARACTER_IMAGE_PATH;
    if (!characterImagePath || !fs.existsSync(characterImagePath)) {
      throw new Error(
        `Fixed character image not found: ${characterImagePath || "(missing path)"}.`,
      );
    }
    await ensureFlowVideoConfiguration(page);
    await uploadIngredientToFlow(
      page,
      characterImagePath,
      "Miss_Rashi character reference",
    );

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
      const taskCharacterPath = task.characterImagePath || characterImagePath;
      if (
        path.resolve(taskCharacterPath) !== path.resolve(characterImagePath)
      ) {
        throw new Error(
          `Clip ${clipIndex} uses a different character image. All clips must use the same character reference.`,
        );
      }
      fs.rmSync(clipDest, { force: true });
      const identityPrompt =
        `Use the exact same woman shown in the ${path.basename(characterImagePath)} ` +
        "character reference. Preserve her face and identity; do not generate a different person. " +
        "The dress reference controls clothing only.\n\n";
      const flowPrompt = `${identityPrompt}${String(task.prompt).trim()}`;
      copyToWindowsClipboard(flowPrompt);
      console.log("\n------------------------------------------------------");
      console.log(
        `🎬 CLIP [${clipIndex}/${tasks.length}]: ${String(task.title || `Dress ${clipIndex}`).slice(0, 70)}`,
      );
      console.log(`📸 Ingredient Image: ${task.imagePath}`);
      console.log(`📋 Prompt: "${flowPrompt.slice(0, 100)}..."`);
      console.log("------------------------------------------------------");
      try {
        // Force and verify Video + Ingredients + required preferences first.
        await ensureFlowVideoConfiguration(page);

        if (i > 0) {
          // Remove the previous clip's references.
          await resetFlowPromptIngredients(page);

          // Reuse the character already uploaded for clip 1.
          // Do not upload Miss_Rashi.jpg again.
          await reuseUploadedIngredientInFlow(
            page,
            characterImagePath,
            "Miss_Rashi character reference",
          );
        }

        // Image 1: the dress reference with the original face blurred.
        await uploadIngredientToFlow(page, task.imagePath, "dress reference");
        await waitForIngredientAttachedToPrompt(
          page,
          task.imagePath,
          "dress reference",
        );
        await waitForIngredientAttachedToPrompt(
          page,
          characterImagePath,
          "Miss_Rashi character reference",
        );

        const attachedSources = await getAttachedIngredientSources(page);

        if (attachedSources.length !== 2) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipIndex}-unexpected-reference-count`,
          );

          throw new Error(
            `Clip ${clipIndex}: expected exactly two image references ` +
              `(character and dress), but found ${attachedSources.length}. ` +
              "Generation stopped.",
          );
        }

        console.log(
          "   ✅ Verified two image references before prompt submission.",
        );

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
        await promptBox.fill(flowPrompt);
        console.log("   ✍️ Filled prompt successfully.");
        await waitForIngredientAttachedToPrompt(
          page,
          task.imagePath,
          "dress reference",
        );
        await waitForIngredientAttachedToPrompt(
          page,
          characterImagePath,
          "Miss_Rashi character reference",
        );
        console.log(
          "   👀 Both images and prompt are ready. Waiting 3 seconds before generation...",
        );
        await page.waitForTimeout(3000);
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
            FLOW_VIDEO_SETTINGS.resolution,
            generatedMedia.generatedAsset,
          );
        } catch (error) {
          console.warn(
            `⚠️ ${FLOW_VIDEO_SETTINGS.resolution} download attempt failed: ${error.message}`,
          );
        }

        if (!downloaded) {
          await captureFlowDiagnostics(
            page,
            `clip-${clipIndex}-${FLOW_VIDEO_SETTINGS.resolution}-download-failed`,
          );

          throw new Error(
            `Clip ${clipIndex} was generated, but a ${FLOW_VIDEO_SETTINGS.resolution} download ` +
              "could not be confirmed. Check the Flow diagnostics.",
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

module.exports = { generateClipsInFlow };
