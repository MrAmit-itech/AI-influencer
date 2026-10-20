const fs = require("fs");
const path = require("path");
const { captureFlowDiagnostics, findVisibleLocator } = require("./page");
const { FLOW_VIDEO_SETTINGS } = require("./config");

const flowIngredientSources = new Map();

async function waitForVisibleLocator(
  page,
  selectors,
  options = {},
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, selectors, options);
    if (locator) return locator;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function resetFlowPromptIngredients(page) {
  const clearButton = await findVisibleLocator(
    page,
    ['button[aria-label="Clear prompt"]'],
    { last: true, enabled: true },
  );
  if (clearButton) {
    await clearButton.click({ timeout: 10000 });
  }

  const ingredientRemovers = page.locator(
    'flow-base-prompt-box button[aria-label="Ingredient"]',
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const visibleRemover = await findVisibleLocator(
      page,
      ['flow-base-prompt-box button[aria-label="Ingredient"]'],
      { last: true, enabled: true },
    );
    if (!visibleRemover) break;

    const previousCount = await ingredientRemovers.count();
    await visibleRemover.click({ timeout: 10000 });
    const deadline = Date.now() + 3000;
    let removed = false;
    while (Date.now() < deadline) {
      const remainingRemover = await findVisibleLocator(
        page,
        ['flow-base-prompt-box button[aria-label="Ingredient"]'],
        { last: true, enabled: true },
      );
      const remainingCount = await ingredientRemovers.count();
      if (!remainingRemover || remainingCount < previousCount) {
        removed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!removed) {
      throw new Error(
        "Flow did not remove a previous prompt ingredient; refusing to generate with stale references.",
      );
    }
  }

  if (
    await findVisibleLocator(
      page,
      ['flow-base-prompt-box button[aria-label="Ingredient"]'],
      { last: true, enabled: true },
    )
  ) {
    throw new Error(
      "Flow still has prompt ingredients attached after the reset.",
    );
  }
  const remainingSources = await getAttachedIngredientSources(page);
  if (remainingSources.length) {
    throw new Error(
      "Flow still shows media attached to the prompt after the reset; refusing to add the next clip's references.",
    );
  }
}

async function getAttachedIngredientSources(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      return (
        element.getClientRects().length > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const findPromptBoxes = (root) => {
      const boxes = Array.from(root.querySelectorAll("flow-base-prompt-box"));
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot)
          boxes.push(...findPromptBoxes(element.shadowRoot));
      }
      return boxes;
    };
    const collectImages = (root, sources) => {
      if (root instanceof Element && root.shadowRoot) {
        collectImages(root.shadowRoot, sources);
      }
      for (const image of root.querySelectorAll(
        'img[alt*="ingredient image" i]',
      )) {
        if (isVisible(image)) {
          const source = image.currentSrc || image.src;
          if (source) sources.push(source);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) collectImages(element.shadowRoot, sources);
      }
    };

    const sources = [];
    for (const promptBox of findPromptBoxes(document)) {
      if (isVisible(promptBox)) collectImages(promptBox, sources);
    }
    return [...new Set(sources)];
  });
}

async function waitForIngredientAttachedToPrompt(
  page,
  imagePath,
  label,
  previousSources = null,
) {
  const expectedSource = flowIngredientSources.get(path.resolve(imagePath));

  try {
    await page.waitForFunction(
      ({ expectedSource, previousSources }) => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          return (
            element.getClientRects().length > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const findPromptBoxes = (root) => {
          const boxes = Array.from(
            root.querySelectorAll("flow-base-prompt-box"),
          );
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot)
              boxes.push(...findPromptBoxes(element.shadowRoot));
          }
          return boxes;
        };
        const collectImages = (root, sources) => {
          if (root instanceof Element && root.shadowRoot) {
            collectImages(root.shadowRoot, sources);
          }
          for (const image of root.querySelectorAll(
            'img[alt*="ingredient image" i]',
          )) {
            if (isVisible(image)) {
              const source = image.currentSrc || image.src;
              if (source) sources.push(source);
            }
          }
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) collectImages(element.shadowRoot, sources);
          }
        };

        const sources = [];
        for (const promptBox of findPromptBoxes(document)) {
          if (isVisible(promptBox)) collectImages(promptBox, sources);
        }
        const uniqueSources = [...new Set(sources)];
        if (expectedSource) {
          const normalize = (source) => {
            try {
              const url = new URL(source);
              return `${url.origin}${url.pathname}`;
            } catch {
              return String(source || "").split("?")[0];
            }
          };

          return uniqueSources.some(
            (source) => normalize(source) === normalize(expectedSource),
          );
        }
        if (!previousSources) return uniqueSources.length > 0;
        return uniqueSources.some(
          (source) => !previousSources.includes(source),
        );
      },
      { expectedSource, previousSources },
      { timeout: 15000, polling: 250 },
    );
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    await captureFlowDiagnostics(page, `missing-${label.replace(/\s+/g, "-")}`);
    throw new Error(
      `Flow did not visibly attach ${label} (${path.basename(imagePath)}) to the prompt.`,
    );
  }

  const resolvedPath = path.resolve(imagePath);
  let verifiedSource = flowIngredientSources.get(resolvedPath);

  if (!expectedSource) {
    const sources = await getAttachedIngredientSources(page);

    const newSources = previousSources
      ? sources.filter((source) => !previousSources.includes(source))
      : sources;

    // Do not guess which source represents the uploaded file.
    if (newSources.length !== 1) {
      await captureFlowDiagnostics(
        page,
        `ambiguous-attachment-${path.basename(imagePath)}`,
      );

      throw new Error(
        `Expected exactly one new image attachment for ${label}, ` +
          `but found ${newSources.length}. Refusing to guess.`,
      );
    }

    verifiedSource = newSources[0];
    flowIngredientSources.set(resolvedPath, verifiedSource);
  }

  if (!verifiedSource) {
    throw new Error(`No verified image source was recorded for ${label}.`);
  }

  // A generated-video tile can remain on the page after earlier clips.
  // Refuse to accept its visible media source as a reference image.

  const generatedVideoSources = await page.evaluate(() => {
    const sources = [];

    const addSource = (source) => {
      if (source) sources.push(source);
    };

    for (const tile of document.querySelectorAll("flow-video-tile")) {
      // Only inspect explicitly marked output-thumbnail images.
      // Do not treat every image inside a video card as its output.
      for (const image of tile.querySelectorAll("img.thumbnail, img.image")) {
        addSource(image.currentSrc || image.src || "");
      }

      // Actual video sources and their posters are also useful signals.
      for (const video of tile.querySelectorAll("video")) {
        addSource(video.currentSrc || video.src || "");
        addSource(video.poster || "");
      }
    }

    return [...new Set(sources)];
  });

  if (
    generatedVideoSources.some((source) =>
      sameFlowAssetSource(source, verifiedSource),
    )
  ) {
    flowIngredientSources.delete(resolvedPath);

    await captureFlowDiagnostics(
      page,
      `video-thumbnail-used-as-${label.replace(/\s+/g, "-")}`,
    );

    throw new Error(
      `The attached source for ${label} matches a generated-video asset. ` +
        "The clip was not approved for generation.",
    );
  }
}

async function openFlowIngredientPicker(page, label) {
  const addIngredientsButton = await waitForVisibleLocator(
    page,
    [
      'button[aria-label="Add ingredients to the prompt box"]',
      'button[aria-label*="Add ingredients" i]',
      'button:has-text("Add ingredients")',
    ],
    { last: true, enabled: true },
    15000,
  );
  if (!addIngredientsButton) {
    throw new Error(
      `Could not find Flow's Add ingredients button for ${label}.`,
    );
  }
  await addIngredientsButton.click({ timeout: 10000 });

  const uploadMediaButton = await waitForVisibleLocator(
    page,
    [
      'button[aria-label="Upload media"]',
      'button:has-text("Upload media")',
      '[role="button"]:has-text("Upload media")',
    ],
    { last: true, enabled: true },
    15000,
  );
  if (!uploadMediaButton) {
    throw new Error(`Flow's Upload media option was not found for ${label}.`);
  }
  await uploadMediaButton.click({ timeout: 10000 });

  const panel = page.locator("flow-add-menu-detail-pane").last();
  await panel.waitFor({ state: "visible", timeout: 15000 });
  return panel;
}

async function clickAddToPrompt(page, panel, imagePath, label) {
  const addButtons = page.getByRole("button", {
    name: "Add to prompt",
    exact: true,
  });

  const loadingPreview = panel.locator('[aria-label="Loading preview"]');

  const deadline = Date.now() + 30000;
  let stableReadyChecks = 0;
  let selectedButton = null;

  // Wait for the active panel to settle. Require one visible,
  // enabled Add to prompt button and no visible loading indicator
  // for three consecutive checks.
  while (Date.now() < deadline) {
    const buttonCount = await addButtons.count().catch(() => 0);
    const visibleEnabledButtons = [];

    for (let index = 0; index < buttonCount; index++) {
      const candidate = addButtons.nth(index);

      const visible = await candidate.isVisible().catch(() => false);
      const enabled =
        visible && (await candidate.isEnabled().catch(() => false));

      if (visible && enabled) {
        visibleEnabledButtons.push(candidate);
      }
    }

    const isLoading = await loadingPreview
      .first()
      .isVisible()
      .catch(() => false);

    if (visibleEnabledButtons.length > 1) {
      await captureFlowDiagnostics(
        page,
        `multiple-add-buttons-${path.basename(imagePath)}`,
      );

      throw new Error(
        `Multiple enabled Add to prompt buttons were found for ${label}. ` +
          "Stopped to avoid attaching the wrong asset.",
      );
    }

    if (!isLoading && visibleEnabledButtons.length === 1) {
      stableReadyChecks++;
      selectedButton = visibleEnabledButtons[0];

      if (stableReadyChecks >= 3) {
        break;
      }
    } else {
      stableReadyChecks = 0;
      selectedButton = null;
    }

    await page.waitForTimeout(250);
  }

  if (!selectedButton || stableReadyChecks < 3) {
    await captureFlowDiagnostics(
      page,
      `add-button-not-ready-${path.basename(imagePath)}`,
    );

    throw new Error(
      `Flow did not reach a stable, ready state for ${label} ` +
        "within 30 seconds. The asset was not added.",
    );
  }

  // Record the existing references immediately before the click.
  const previousSources = await getAttachedIngredientSources(page);

  await selectedButton.click({ timeout: 10000 });

  // Verify that a new ingredient appeared in the prompt.
  await waitForIngredientAttachedToPrompt(
    page,
    imagePath,
    label,
    previousSources,
  );

  console.log(`   ✅ Added and detected ${label} in the prompt.`);
}

function normalizeFlowImageUrlForSafeAttach(source) {
  try {
    const url = new URL(source);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(source || "").split("?")[0];
  }
}

async function findFlowUserImageAssetsForSafeAttach(page, fileName) {
  const escaped = fileName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const selectors = [
    `[role="button"][aria-label="${escaped}"]`,
    `[role="option"][aria-label="${escaped}"]`,
    `[title="${escaped}"]`,
  ];

  const results = [];
  const seenSources = new Set();

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);

      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      const details = await candidate
        .evaluate((element) => {
          // Never accept an actual generated-video tile.
          if (
            element.matches("flow-video-tile") ||
            element.closest("flow-video-tile") ||
            element.querySelector("video, flow-video-tile")
          ) {
            return null;
          }

          const images = Array.from(element.querySelectorAll("img"));

          const userImage = images.find((image) =>
            /tile displaying a user's image/i.test(
              image.getAttribute("alt") || "",
            ),
          );

          if (!userImage) return null;

          const source = userImage.currentSrc || userImage.src || "";

          if (!source) return null;

          // Reject a generated-video thumbnail even if its card
          // happens to expose a filename-like accessible label.
          if (/generated video thumbnail/i.test(userImage.alt || "")) {
            return null;
          }

          return { source };
        })
        .catch(() => null);

      if (!details?.source) continue;

      const key = normalizeFlowImageUrlForSafeAttach(details.source);

      if (seenSources.has(key)) continue;
      seenSources.add(key);

      results.push({
        locator: candidate,
        source: details.source,
      });
    }
  }

  return results;
}

async function waitForNewFlowUserImageForSafeAttach(
  page,
  fileName,
  previousSources,
  timeoutMs = 45000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const candidates = await findFlowUserImageAssetsForSafeAttach(
      page,
      fileName,
    );

    const newAsset = candidates.find(
      (asset) =>
        !previousSources.has(normalizeFlowImageUrlForSafeAttach(asset.source)),
    );

    if (newAsset) return newAsset;

    await page.waitForTimeout(300);
  }

  return null;
}


async function uploadIngredientToFlow(
  page,
  imagePath,
  label,
  options = {},
) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(
      `${label} image does not exist: ${imagePath || "(missing path)"}`,
    );
  }

  const resolvedPath = path.resolve(imagePath);
  const fileName = path.basename(imagePath);
  const forceUpload = options.forceUpload === true;

  if (!forceUpload && flowIngredientSources.has(resolvedPath)) {
    await reuseUploadedIngredientInFlow(page, imagePath, label);
    return;
  }

  flowIngredientSources.delete(resolvedPath);

  console.log(`   📸 Preparing image: ${fileName}`);

  // Open Flow's existing media picker.
  const panel = await openFlowIngredientPicker(page, label);

  let asset = null;

  // IMPORTANT: Reuse an existing image when Flow already has it.
  // This prevents unnecessary uploads and avoids relying on a
  // "Preview of filename" element that might still show the old dress.
  if (!forceUpload) {
    asset = await findUploadedProjectAsset(page, panel, fileName);
  }

  if (asset) {
    console.log(`   🔎 Found existing Flow image: ${fileName}`);
  } else {
    console.log(`   📤 Uploading local image: ${fileName}`);

    // Only open the local file chooser when the asset is not found.
    const uploadButtons = page.getByRole("button", {
      name: /Upload media/i,
    });

    let uploadButton = null;
    const buttonCount = await uploadButtons.count();

    for (let index = buttonCount - 1; index >= 0; index--) {
      const candidate = uploadButtons.nth(index);

      if (
        (await candidate.isVisible().catch(() => false)) &&
        (await candidate.isEnabled().catch(() => false))
      ) {
        uploadButton = candidate;
        break;
      }
    }

    if (!uploadButton) {
      await captureFlowDiagnostics(
        page,
        `upload-button-not-found-${fileName.replace(/\.[^.]+$/, "")}`,
      );

      throw new Error(
        `Cannot find the Upload media button for ${fileName}.`,
      );
    }

    try {
      const chooserPromise = page.waitForEvent("filechooser", {
        timeout: 10000,
      });

      await uploadButton.click({ timeout: 10000 });

      const chooser = await chooserPromise;
      await chooser.setFiles(imagePath);
    } catch (error) {
      await captureFlowDiagnostics(
        page,
        `file-chooser-failed-${fileName.replace(/\.[^.]+$/, "")}`,
      );

      throw new Error(
        `Could not upload ${fileName} through Flow: ${error.message}`,
      );
    }

    // Wait for the named Image option to appear.
    // Do not wait for a preview that may belong to an earlier image.
    asset = await findUploadedProjectAsset(page, panel, fileName);

    if (!asset) {
      await captureFlowDiagnostics(
        page,
        `uploaded-image-option-not-found-${fileName.replace(/\.[^.]+$/, "")}`,
      );

      throw new Error(
        `Flow did not expose an Image option for ${fileName} after upload.`,
      );
    }
  }

  // Capture the prompt state before selecting the intended image.
  const sourcesBefore = await getAttachedIngredientSources(page);

  // findUploadedProjectAsset only accepts an option named
  // "<filename> Image"; it must not select a Video option.
  await asset.click({ timeout: 10000 });
  await page.waitForTimeout(300);

  const normalizeSource = (source) => {
    try {
      const url = new URL(source);
      return `${url.origin}${url.pathname}`;
    } catch {
      return String(source || "").split("?")[0];
    }
  };

  const currentSources = await getAttachedIngredientSources(page);
  const previousKeys = new Set(
    sourcesBefore.map(normalizeSource),
  );

  const newlyAttached = currentSources.filter(
    (source) => !previousKeys.has(normalizeSource(source)),
  );

  if (newlyAttached.length > 1) {
    await captureFlowDiagnostics(
      page,
      `multiple-new-attachments-${fileName.replace(/\.[^.]+$/, "")}`,
    );

    throw new Error(
      `Selecting ${fileName} produced multiple new attachments. ` +
        "Stopped rather than guessing.",
    );
  }

  if (newlyAttached.length === 1) {
    flowIngredientSources.set(resolvedPath, newlyAttached[0]);

    await waitForIngredientAttachedToPrompt(
      page,
      imagePath,
      label,
      sourcesBefore,
    );
  } else {
    // Selecting the image did not attach it yet. Use the Add to
    // prompt button in the current picker.
    await clickAddToPrompt(page, panel, imagePath, label);
  }

  const expectedSource = flowIngredientSources.get(resolvedPath);
  const finalSources = await getAttachedIngredientSources(page);

  const verified = Boolean(
    expectedSource &&
      finalSources.some(
        (source) =>
          normalizeSource(source) === normalizeSource(expectedSource),
      ),
  );

  if (!verified) {
    await captureFlowDiagnostics(
      page,
      `image-attachment-not-verified-${fileName.replace(/\.[^.]+$/, "")}`,
    );

    throw new Error(
      `Flow did not verify ${fileName} in the prompt. ` +
        "Generation stopped.",
    );
  }

  console.log(`   ✅ Image selected and verified: ${fileName}`);
}


async function findUploadedProjectAsset(page, panel, fileName) {
  const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Flow's current UI exposes uploaded images as options whose
  // accessible name ends in "Image". Video options end in "Video".
  const imageOption = page.getByRole("option", {
    name: new RegExp(`^${escapedFileName}\\s+Image$`, "i"),
  });

  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    const count = await imageOption.count().catch(() => 0);

    // Search from the end because Flow may contain duplicate
    // uploads with the same filename.
    for (let index = count - 1; index >= 0; index--) {
      const candidate = imageOption.nth(index);

      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      const text = (await candidate.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();

      if (!new RegExp(`^${escapedFileName}\\s+Image$`, "i").test(text)) {
        continue;
      }

      const isVideo = await candidate
        .evaluate((element) =>
          Boolean(
            element.closest("flow-video-tile") ||
            element.querySelector("video, flow-video-tile"),
          ),
        )
        .catch(() => true);

      if (!isVideo) {
        return candidate;
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

function normalizeFlowAssetSource(source) {
  try {
    const url = new URL(source);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(source || "").split("?")[0];
  }
}

function sameFlowAssetSource(first, second) {
  return (
    Boolean(first && second) &&
    normalizeFlowAssetSource(first) === normalizeFlowAssetSource(second)
  );
}

async function getUploadedUserImageSource(assetLocator) {
  try {
    return await assetLocator.evaluate((element) => {
      // Ignore assets that belong to a generated-video tile.
      if (element.closest("flow-video-tile")) {
        return null;
      }

      const tile = element.closest("flow-tile-container");

      if (!tile || tile.querySelector("flow-video-tile")) {
        return null;
      }

      const images = Array.from(tile.querySelectorAll("img"));

      const userImage = images.find((image) => {
        const alt = image.getAttribute("alt") || "";
        return /user.*image/i.test(alt) && image.getClientRects().length > 0;
      });

      return userImage ? userImage.currentSrc || userImage.src || null : null;
    });
  } catch {
    return null;
  }
}

async function reuseUploadedIngredientInFlow(page, imagePath, label) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(
      `${label} image does not exist: ${imagePath || "(missing path)"}`,
    );
  }

  const resolvedPath = path.resolve(imagePath);
  const fileName = path.basename(imagePath);

  const normalizeSource = (source) => {
    try {
      const url = new URL(source);
      return `${url.origin}${url.pathname}`;
    } catch {
      return String(source || "").split("?")[0];
    }
  };

  // If the correct cached image is already attached, don't add it twice.
  const cachedSource = flowIngredientSources.get(resolvedPath);
  const currentSources = await getAttachedIngredientSources(page);

  if (
    cachedSource &&
    currentSources.some(
      (source) => normalizeSource(source) === normalizeSource(cachedSource),
    )
  ) {
    console.log(`   ✅ ${label} is already attached.`);
    return;
  }

  // The previous prompt has been cleared, so do not trust a stale
  // cached URL. Learn the attachment source again after selecting it.
  flowIngredientSources.delete(resolvedPath);

  async function selectFlowPickerImagesCategory(page, panel) {
    const imageFilter = await waitForVisibleLocator(
      panel,
      [
        '[role="tab"]:has-text("Images")',
        'button:has-text("Images")',
        '[role="button"]:has-text("Images")',
        'text="Images"',
      ],
      { last: false, enabled: true },
      8000,
    );

    if (!imageFilter) {
      await captureFlowDiagnostics(page, "flow-picker-images-filter-not-found");

      throw new Error(
        "Flow's media picker did not expose the Images filter. " +
          "Stopped rather than choosing an arbitrary asset.",
      );
    }

    await imageFilter.click({ timeout: 10000 });
    await page.waitForTimeout(400);

    console.log("   ✅ Opened the Images category in Flow's media picker.");
  }

  const panel = await openFlowIngredientPicker(page, label);
  

  
const assetName = path.basename(imagePath);
const resolvedImagePath = path.resolve(imagePath);

// First try to reuse this exact image from Flow's media picker.
// The image option must end with "Image", not "Video".
const existingAsset = await findUploadedProjectAsset(
  page,
  panel,
  assetName,
);

if (existingAsset) {
  console.log(
    `   🔎 Reusing existing Flow image instead of uploading again: ${assetName}`,
  );

  const sourcesBefore = await getAttachedIngredientSources(page);

  // Select the matching image option.
  await existingAsset.click({ timeout: 10000 });
  await page.waitForTimeout(300);

  const sourcesAfterSelection = await getAttachedIngredientSources(page);
  const newlyAttached = sourcesAfterSelection.filter(
    (source) => !sourcesBefore.includes(source),
  );

  if (newlyAttached.length > 1) {
    await captureFlowDiagnostics(
      page,
      `ambiguous-existing-image-${assetName.replace(/\.[^.]+$/, "")}`,
    );

    throw new Error(
      `Selecting ${assetName} produced multiple new attachments. ` +
        "Stopped rather than guessing.",
    );
  }

  if (newlyAttached.length === 1) {
    // Flow attached the selected image immediately.
    flowIngredientSources.set(resolvedImagePath, newlyAttached[0]);

    await waitForIngredientAttachedToPrompt(
      page,
      imagePath,
      label,
      sourcesBefore,
    );
  } else {
    // Selecting the option did not attach it yet.
    // Click Add to prompt for the selected image.
    await clickAddToPrompt(page, panel, imagePath, label);
  }

  const finalSources = await getAttachedIngredientSources(page);
  const expectedSource = flowIngredientSources.get(resolvedImagePath);

  if (!expectedSource || !finalSources.includes(expectedSource)) {
    await captureFlowDiagnostics(
      page,
      `existing-image-not-attached-${assetName.replace(/\.[^.]+$/, "")}`,
    );

    throw new Error(
      `Flow did not verify the selected image ${assetName} in the prompt.`,
    );
  }

  console.log(`   ✅ Existing image selected and verified: ${assetName}`);
  return;
}

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureFlowVideoConfiguration(page) {
  console.log("\n⚙️ Enforcing required Google Flow configuration...");

  await ensureFlowSettingsPanel(page);

  const generationModeSelectors =
    FLOW_VIDEO_SETTINGS.generationMode === "Video"
      ? [
          'flow-prompt-box-settings mat-button-toggle:has(mat-icon:has-text("videocam")) button',
          'mat-button-toggle:has(mat-icon:has-text("videocam")) button',
          `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.generationMode}")`,
        ]
      : [
          `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.generationMode}") button`,
          `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.generationMode}")`,
        ];

  await ensureFlowControlSelected(
    page,
    generationModeSelectors,
    FLOW_VIDEO_SETTINGS.generationMode,
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

  const modelPattern = new RegExp(escapeRegExp(FLOW_VIDEO_SETTINGS.model), "i");
  if (!modelPattern.test(currentModel)) {
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
        `div.mat-mdc-menu-content flow-menu-item button[role="menuitem"]:has-text("${FLOW_VIDEO_SETTINGS.model}")`,
        `[role="menuitem"]:has-text("${FLOW_VIDEO_SETTINGS.model}")`,
      ],
      { last: false, enabled: true },
    );

    if (!modelOption) {
      await captureFlowDiagnostics(page, "missing-configured-flow-model");
      throw new Error(
        `Flow does not expose the configured model "${FLOW_VIDEO_SETTINGS.model}".`,
      );
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

  if (!modelPattern.test(currentModel)) {
    await captureFlowDiagnostics(page, "model-selection-not-verified");
    throw new Error(
      `Required model is "${FLOW_VIDEO_SETTINGS.model}", but Flow displays "${currentModel}".`,
    );
  }

  console.log(`   ✅ Verified Flow model: ${FLOW_VIDEO_SETTINGS.model}`);

  await ensureFlowSettingsPanel(page);

  const ingredientModeSelectors =
    FLOW_VIDEO_SETTINGS.ingredientMode === "Ingredients"
      ? [
          'flow-prompt-box-settings mat-button-toggle:has(mat-icon:has-text("chrome_extension")) button',
          'mat-button-toggle:has(mat-icon:has-text("chrome_extension")) button',
          `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.ingredientMode}") button`,
          `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.ingredientMode}")`,
        ]
      : [
          `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.ingredientMode}") button`,
          `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.ingredientMode}")`,
        ];

  await ensureFlowControlSelected(
    page,
    ingredientModeSelectors,
    FLOW_VIDEO_SETTINGS.ingredientMode,
  );

  const aspectRatioSelectors =
    FLOW_VIDEO_SETTINGS.aspectRatio === "9:16"
      ? [
          'flow-prompt-box-settings mat-button-toggle:has(mat-icon:has-text("crop_9_16")) button',
          'mat-button-toggle:has(mat-icon:has-text("crop_9_16")) button',
          `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.aspectRatio}") button`,
          `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.aspectRatio}")`,
        ]
      : [
          `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.aspectRatio}") button`,
          `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.aspectRatio}")`,
        ];

  await ensureFlowControlSelected(
    page,
    aspectRatioSelectors,
    FLOW_VIDEO_SETTINGS.aspectRatio,
  );

  // 5. Set 720p quality.
  await ensureFlowControlSelected(
    page,
    [
      `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.resolution}") button`,
      `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.resolution}")`,
      `flow-prompt-box-settings [role="button"]:has-text("${FLOW_VIDEO_SETTINGS.resolution}")`,
    ],
    FLOW_VIDEO_SETTINGS.resolution,
  );

  // 6. Set duration to exactly four seconds.
  await ensureFlowControlSelected(
    page,
    [
      `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.duration}") button`,
      `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.duration}")`,
      `flow-prompt-box-settings [role="button"]:has-text("${FLOW_VIDEO_SETTINGS.duration}")`,
    ],
    FLOW_VIDEO_SETTINGS.duration,
  );

  // 7. Set exactly one output.
  await ensureFlowControlSelected(
    page,
    [
      `flow-prompt-box-settings mat-button-toggle:has-text("${FLOW_VIDEO_SETTINGS.outputs}") button`,
      `flow-prompt-box-settings button:has-text("${FLOW_VIDEO_SETTINGS.outputs}")`,
      `flow-prompt-box-settings [role="button"]:has-text("${FLOW_VIDEO_SETTINGS.outputs}")`,
    ],
    FLOW_VIDEO_SETTINGS.outputs,
  );

  console.log("✅ All required Flow settings were selected and verified.");

  // Close settings so they do not obstruct the ingredient controls.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}

module.exports = {
  uploadIngredientToFlow,
  reuseUploadedIngredientInFlow,
  findUploadedProjectAsset,
  getAttachedIngredientSources,
  resetFlowPromptIngredients,
  waitForIngredientAttachedToPrompt,
  waitForVisibleLocator,
  ensureFlowVideoConfiguration,
};
