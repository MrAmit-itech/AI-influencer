const { DIRS, FLOW_GENERATION_TIMEOUT_MS } = require("../config");
const { captureFlowDiagnostics, getFlowMediaSnapshot } = require("./page");

function findNewCompletedVideoTile(current, baseline) {
  const previousSignatures = new Set(
    (baseline.videoTiles || []).map((tile) => tile.signature),
  );
  const baselineCount = Number(baseline.videoTileCount || 0);
  if (Number(current.videoTileCount || 0) <= baselineCount) return null;

  return (
    (current.videoTiles || []).find(
      (tile) =>
        !previousSignatures.has(tile.signature) &&
        tile.complete &&
        !tile.failed,
    ) || null
  );
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
    if (page.isClosed()) {
      throw new Error(
        `Flow closed the browser page while clip ${clipIndex} was rendering; ` +
          "the clip was not confirmed or downloaded.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const current = await getFlowMediaSnapshot(page).catch(() => null);

    if (!current) {
      if (page.isClosed()) {
        throw new Error(
          `Flow closed the browser page while clip ${clipIndex} was rendering; ` +
            "the clip was not confirmed or downloaded.",
        );
      }
      continue;
    }

    const candidate = findNewCompletedVideoTile(current, baseline);

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

    // Confirm the same completed video card across consecutive checks.
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
          `new signatures: ${
            (current.videoTiles || []).filter(
              (tile) => !oldVideoTileSignatures.has(tile.signature),
            ).length
          }, ` +
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

module.exports = {
  findNewCompletedVideoTile,
  openDetectedFlowAsset,
  waitForNewGeneratedAsset,
  hoverLatestFlowAsset,
};
