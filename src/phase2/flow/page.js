const path = require("path");
const fs = require("fs");
const { DIRS, FLOW_GENERATION_TIMEOUT_MS, FLOW_DOWNLOAD_TIMEOUT_MS } = require("../config");

async function findVisibleLocator(page, selectors, options = {}) {
  const searchLast = options.last !== false;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const indices = searchLast
      ? Array.from({ length: count }, (_, index) => count - 1 - index)
      : Array.from({ length: count }, (_, index) => index);
    for (const index of indices) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (options.enabled && !(await candidate.isEnabled().catch(() => false)))
        continue;
      return candidate;
    }
  }
  return null;
}

async function captureFlowDiagnostics(page, label) {
  const safeLabel =
    String(label || "flow")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "flow";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basePath = path.join(DIRS.output, `flow-debug-${safeLabel}-${stamp}`);
  const jsonPath = `${basePath}.json`;
  const pngPath = `${basePath}.png`;
  try {
    const snapshot = await page.evaluate(() => {
      const visible = (element) =>
        Boolean(element && element.getClientRects().length);
      const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        text: String(
          element.innerText ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            "",
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        disabled: Boolean(element.disabled),
        role: element.getAttribute("role"),
      });
      return {
        url: location.href,
        title: document.title,
        bodyTextTail: (document.body?.innerText || "").slice(-12000),
        visibleControls: Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="menuitem"]',
          ),
        )
          .filter(visible)
          .slice(-100)
          .map(describe),
        videos: Array.from(document.querySelectorAll("video")).map((video) => ({
          src: video.currentSrc || video.src || "",
          poster: video.poster || "",
          readyState: video.readyState,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          visible: visible(video),
        })),
        images: Array.from(document.querySelectorAll("img"))
          .filter(visible)
          .slice(-80)
          .map((img) => ({
            src: img.currentSrc || img.src || "",
            alt: img.alt || "",
          })),
      };
    });
    fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ error: error.message }, null, 2),
      "utf8",
    );
  }
  try {
    await page.screenshot({ path: pngPath, fullPage: true, timeout: 15000 });
  } catch (error) {
    console.warn(`   ⚠️ Could not save Flow screenshot: ${error.message}`);
  }
  console.log(`   🧾 Flow diagnostics saved: ${jsonPath}`);
  console.log(`   🖼️ Flow screenshot saved: ${pngPath}`);
  return { jsonPath, pngPath };
}

async function getFlowMediaSnapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element || !element.getClientRects().length) {
        return false;
      }

      const style = window.getComputedStyle(element);

      return style.display !== "none" && style.visibility !== "hidden";
    };

    const cleanText = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);

    // All visible HTML video elements. These are diagnostic signals;
    // the specific Flow video card below is the primary target.
    const videos = Array.from(document.querySelectorAll("video")).map(
      (video, domIndex) => ({
        domIndex,
        src: video.currentSrc || video.src || "",
        poster: video.poster || "",
        visible: visible(video),
        readyState: video.readyState,
        duration: Number.isFinite(video.duration) ? video.duration : null,
      }),
    );

    const imageDetails = Array.from(document.querySelectorAll("img"))
      .map((img, domIndex) => {
        if (!visible(img)) return null;

        return {
          domIndex,
          src: img.currentSrc || img.src || "",
          alt: img.alt || "",
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
        };
      })
      .filter(Boolean)
      .filter((img) => img.src);

    // IMPORTANT: only flow-video-tile elements qualify as
    // generated video assets. A standalone image cannot qualify.
    const allContainers = Array.from(
      document.querySelectorAll("flow-tile-container"),
    );

    const videoTiles = Array.from(document.querySelectorAll("flow-video-tile"))
      .map((tile, domIndex) => {
        if (!visible(tile)) return null;

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

        const parentContainer = tile.closest("flow-tile-container");

        const containerIndex = parentContainer
          ? allContainers.indexOf(parentContainer)
          : -1;

        const identity =
          tile.getAttribute("data-asset-id") ||
          tile.getAttribute("data-id") ||
          tile.id ||
          "";

        const signature = [identity, thumbnailSrc, videoSrc, poster].join("::");

        const pending = [
          ...tile.querySelectorAll(
            "flow-pending-tile, [aria-busy='true'], [role='progressbar'], progress",
          ),
        ].some((indicator) => {
          if (!visible(indicator)) return false;
          if (indicator.matches("flow-pending-tile, [aria-busy='true']")) {
            return true;
          }

          const value =
            indicator instanceof HTMLProgressElement
              ? indicator.value
              : Number(indicator.getAttribute("aria-valuenow"));
          const maximum =
            indicator instanceof HTMLProgressElement
              ? indicator.max
              : Number(indicator.getAttribute("aria-valuemax") || 100);

          return !Number.isFinite(value) || !Number.isFinite(maximum) || value < maximum;
        });

        const failed = Boolean(
          tile.querySelector(
            "flow-error-tile, .error-tile, .error-tile-content",
          ),
        );

        const mediaSource = thumbnailSrc || videoSrc || poster;

        const hasUsableMedia =
          Boolean(mediaSource) &&
          !mediaSource.startsWith("data:image/svg") &&
          !mediaSource.includes("placeholder");

        return {
          kind: "video-tile",
          domIndex,
          containerIndex,
          identity,
          thumbnailSrc,
          videoSrc,
          poster,
          signature,
          pending,
          failed,
          hasUsableMedia,
          complete: hasUsableMedia && !pending && !failed,
          text: cleanText(tile.innerText || ""),
        };
      })
      .filter(Boolean);

    // Generic cards remain available for diagnostics only.
    // They are never accepted as generated-video evidence.
    const assetTileCount = allContainers.filter(visible).length;

    const busyElement = Array.from(
      document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], progress',
      ),
    ).some((indicator) => {
      if (!visible(indicator)) return false;
      if (indicator.matches('[aria-busy="true"]')) return true;

      const value =
        indicator instanceof HTMLProgressElement
          ? indicator.value
          : Number(indicator.getAttribute("aria-valuenow"));
      const maximum =
        indicator instanceof HTMLProgressElement
          ? indicator.max
          : Number(indicator.getAttribute("aria-valuemax") || 100);

      return !Number.isFinite(value) || !Number.isFinite(maximum) || value < maximum;
    });

    const bodyText = document.body?.innerText || "";

    const busyText =
      /\b(generating video|creating video|rendering video|processing video|in queue|queued|generation in progress)\b/i.test(
        bodyText,
      );

    const downloadControlCount = Array.from(
      document.querySelectorAll('button, [role="button"]'),
    )
      .filter(visible)
      .filter((element) =>
        /download/i.test(
          `${element.getAttribute("aria-label") || ""} ${
            element.getAttribute("title") || ""
          } ${element.innerText || ""}`,
        ),
      ).length;

    return {
      videos,
      videoTiles,
      images: imageDetails.map((img) => img.src),
      imageDetails,
      assetTiles: [],
      videoCount: videos.length,
      videoTileCount: videoTiles.length,
      assetTileCount,
      downloadControlCount,
      visibleMediaCount:
        videos.filter((video) => video.visible).length + imageDetails.length,
      busy: busyElement || busyText,
    };
  });
}

module.exports = { findVisibleLocator, captureFlowDiagnostics, getFlowMediaSnapshot };
