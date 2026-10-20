const fs = require("fs");
const { DIRS, FLOW_DOWNLOAD_TIMEOUT_MS } = require("../config");
const { findVisibleLocator, captureFlowDiagnostics } = require("./page");

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

  if (typeof resolution !== "string" || !resolution.trim()) {
    throw new Error(
      `Invalid Flow export resolution "${resolution}". Set a non-empty resolution in flow/config.js.`,
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

module.exports = { attemptFlowDownload };
