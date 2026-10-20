const {
  DIRS,
  FLOW_GENERATION_TIMEOUT_MS,
} = require("../config");

const {
  captureFlowDiagnostics,
  getFlowMediaSnapshot,
} = require("./page");

function findNewCompletedVideoTile(current, baseline) {
  const previousSignatures = new Set(
    (baseline.videoTiles || []).map((tile) => tile.signature)
  );

  const previousCount = Number(baseline.videoTileCount || 0);
  const currentCount = Number(current.videoTileCount || 0);

  /*
   * Preserve the original safety check: the visible video-card count
   * must increase after the generation is submitted.
   */
  if (currentCount <= previousCount) {
    return null;
  }

  return (
    (current.videoTiles || []).find(
      (tile) =>
        !previousSignatures.has(tile.signature) &&
        tile.complete &&
        !tile.pending &&
        !tile.failed
    ) || null
  );
}

async function openDetectedFlowAsset(page, asset, clipNumber) {
  if (asset?.kind === "tile") {
    const locator = page
      .locator('[role="gridcell"], [data-testid*="asset" i]')
      .nth(asset.item.domIndex);

    if (await locator.isVisible().catch(() => false)) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});

      try {
        await locator.click({ timeout: 8000 });

        console.log(
          `   🖱️ Opened the detected Flow asset for clip ${clipNumber}.`
        );

        await page.waitForTimeout(1200);
        return true;
      } catch (error) {
        console.warn(
          `   ⚠️ Could not open the new asset tile: ${error.message}`
        );
      }
    }
  }

  if (asset?.kind === "image") {
    const locator = page.locator("img").nth(asset.item.domIndex);

    if (await locator.isVisible().catch(() => false)) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});

      try {
        await locator.click({ timeout: 8000 });

        console.log(
          `   🖱️ Opened the detected media thumbnail for clip ${clipNumber}.`
        );

        await page.waitForTimeout(1200);
        return true;
      } catch (error) {
        console.warn(
          `   ⚠️ Could not open the new thumbnail: ${error.message}`
        );
      }
    }
  }

  return false;
}

async function waitForNewGeneratedAsset(page, baseline, clipNumber) {
  const deadline = Date.now() + FLOW_GENERATION_TIMEOUT_MS;

  const baselineSignatures = new Set(
    (baseline.videoTiles || []).map((tile) => tile.signature)
  );

  const baselineCount = Number(baseline.videoTileCount || 0);

  let lastCandidateSignature = null;
  let stableChecks = 0;
  let lastLogTime = 0;
  let lastProgressLogTime = 0;

  console.log(
    `   ⏳ Waiting up to ${Math.round(
      FLOW_GENERATION_TIMEOUT_MS / 1000
    )}s for a new completed video card for clip ${clipNumber}...`
  );

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error(
        `Flow closed the browser page while clip ${clipNumber} was rendering. ` +
          "The clip was not confirmed or downloaded."
      );
    }

    await page.waitForTimeout(2500);

    const current = await getFlowMediaSnapshot(page).catch(() => null);

    if (!current) {
      if (page.isClosed()) {
        throw new Error(
          `Flow closed the browser page while clip ${clipNumber} was rendering.`
        );
      }

      continue;
    }

    /*
     * CRITICAL SAFETY CHECK:
     * Do not accept a card while the page shows generation progress.
     * This includes Flow's play_circle + percentage display.
     */
    if (current.busy) {
      lastCandidateSignature = null;
      stableChecks = 0;

      if (Date.now() - lastProgressLogTime >= 10000) {
        console.log(
          `   ⏳ Flow still shows generation progress for clip ${clipNumber}. ` +
            "Waiting before considering any video card downloadable."
        );

        console.log(
          `   🔎 Percentage indicator detected: ${
            current.progressTextDetected ? "yes" : "no"
          }`
        );

        lastProgressLogTime = Date.now();
      }

      continue;
    }

    const candidate = findNewCompletedVideoTile(current, baseline);

    if (candidate) {
      if (candidate.signature === lastCandidateSignature) {
        stableChecks += 1;
      } else {
        lastCandidateSignature = candidate.signature;
        stableChecks = 1;
      }
    } else {
      lastCandidateSignature = null;
      stableChecks = 0;
    }

    if (candidate && stableChecks >= 3) {
      console.log(
        `   ✅ Stable, completed new video card detected for clip ${clipNumber}.`
      );

      console.log(
        `   🎯 Video tile index: ${candidate.domIndex}; ` +
          `container index: ${candidate.containerIndex}.`
      );

      console.log(
        `   🔑 Stable card identity: ${candidate.signature}`
      );

      console.log(
        `   🖼️ Thumbnail available: ${
          candidate.thumbnailSrc ? "yes" : "no"
        }; video source inside card: ${
          candidate.videoSrc ? "yes" : "not exposed"
        }.`
      );

      return {
        ...current,
        generatedAsset: {
          kind: "video-tile",
          domIndex: candidate.domIndex,
          containerIndex: candidate.containerIndex,
          identity: candidate.identity,
          src:
            candidate.thumbnailSrc ||
            candidate.videoSrc ||
            candidate.poster ||
            "",
          signature: candidate.signature,
        },
      };
    }

    if (Date.now() - lastLogTime >= 15000) {
      const newSignatures = (current.videoTiles || []).filter(
        (tile) => !baselineSignatures.has(tile.signature)
      );

      console.log(
        `   … waiting (video cards: ${current.videoTileCount}, ` +
          `baseline: ${baselineCount}, ` +
          `new card signatures: ${newSignatures.length}, ` +
          `activity: ${current.busy ? "busy" : "idle"})`
      );

      console.log(
        "   🔎 Video card states:",
        JSON.stringify(
          (current.videoTiles || []).map((tile) => ({
            domIndex: tile.domIndex,
            containerIndex: tile.containerIndex,
            signature: tile.signature,
            pending: tile.pending,
            failed: tile.failed,
            hasMediaSource: tile.hasUsableMedia,
            complete: tile.complete,
            text: tile.text,
          }))
        )
      );

      lastLogTime = Date.now();
    }
  }

  await captureFlowDiagnostics(
    page,
    `clip-${clipNumber}-video-tile-timeout`
  );

  throw new Error(
    `Flow did not expose a stable, completed new video card within ` +
      `${Math.round(FLOW_GENERATION_TIMEOUT_MS / 1000)} seconds for clip ${clipNumber}. ` +
      "The automation stopped without accepting an unconfirmed asset. " +
      "Check the saved Flow debug JSON and screenshot."
  );
}

async function hoverLatestFlowAsset(page) {
  const video = await findVisibleVideo(page);

  if (video) {
    await video.scrollIntoViewIfNeeded().catch(() => {});
    await video.hover({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }

  const locator = page.locator(
    '[role="gridcell"], [data-testid*="asset" i], img'
  ).last();

  if (!(await locator.isVisible().catch(() => false))) {
    return false;
  }

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.hover({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

  return true;
}

async function findVisibleVideo(page) {
  const videos = page.locator("video");
  const count = await videos.count().catch(() => 0);

  for (let index = count - 1; index >= 0; index--) {
    const video = videos.nth(index);

    if (await video.isVisible().catch(() => false)) {
      return video;
    }
  }

  return null;
}

module.exports = {
  findNewCompletedVideoTile,
  openDetectedFlowAsset,
  waitForNewGeneratedAsset,
  hoverLatestFlowAsset,
};