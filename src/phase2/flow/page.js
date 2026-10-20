const path = require("path");
const fs = require("fs");

const {
  DIRS,
  FLOW_GENERATION_TIMEOUT_MS,
  FLOW_DOWNLOAD_TIMEOUT_MS,
} = require("../config");

async function findVisibleLocator(page, selectors, options = {}) {
  const searchLastFirst = options.last !== false;

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    if (!count) continue;

    const indexes = searchLastFirst
      ? Array.from({ length: count }, (_, i) => count - 1 - i)
      : Array.from({ length: count }, (_, i) => i);

    for (const index of indexes) {
      const item = locator.nth(index);

      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }

      if (
        options.enabled &&
        !(await item.isEnabled().catch(() => false))
      ) {
        continue;
      }

      return item;
    }
  }

  return null;
}

async function captureFlowDiagnostics(page, label) {
  const safeLabel =
    String(label || "flow")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "flow";

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basePath = path.join(
    DIRS.output,
    `flow-debug-${safeLabel}-${timestamp}`
  );

  const jsonPath = `${basePath}.json`;
  const pngPath = `${basePath}.png`;

  try {
    const data = await page.evaluate(() => {
      const isVisible = (element) =>
        Boolean(element && element.getClientRects().length);

      const bodyText = document.body?.innerText || "";
      const normalizedBodyText = bodyText.replace(/\s+/g, " ");

      const progressTextDetected =
        /play_circle\s+\d{1,3}%/i.test(normalizedBodyText);

      const videoTiles = Array.from(
        document.querySelectorAll("flow-video-tile")
      ).map((tile, domIndex) => {
        const container = tile.closest("flow-tile-container");
        const image = tile.querySelector(
          "img.thumbnail, img.image, img"
        );

        const thumbnailSrc = image
          ? image.currentSrc ||
            image.src ||
            image.getAttribute("src") ||
            ""
          : "";

        const videos = Array.from(
          tile.querySelectorAll("video")
        ).map((video) => ({
          src: video.currentSrc || video.src || "",
          poster: video.poster || "",
          readyState: video.readyState,
          duration: Number.isFinite(video.duration)
            ? video.duration
            : null,
        }));

        const assetId =
          tile.getAttribute("data-asset-id") ||
          tile.getAttribute("data-id") ||
          tile.id ||
          "";

        const containerText = String(
          container?.innerText || tile.innerText || ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200);

        const pendingSelector =
          "flow-pending-tile, [aria-busy='true'], " +
          "[role='progressbar'], progress";

        const pending =
          Boolean(
            tile.querySelector(pendingSelector) ||
              container?.querySelector(pendingSelector)
          ) ||
          /\b\d{1,3}%\b/.test(containerText) &&
            /play_circle/i.test(containerText);

        return {
          domIndex,
          visible: isVisible(tile),
          containerIndex: container
            ? Array.from(
                document.querySelectorAll("flow-tile-container")
              ).indexOf(container)
            : -1,
          assetId,
          thumbnailSrc,
          videos,
          pending,
          containerText,
        };
      });

      return {
        url: location.href,
        title: document.title,
        bodyTextTail: bodyText.slice(-12000),
        progressTextDetected,
        videoTiles,
        visibleControls: Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="menuitem"]'
          )
        )
          .filter(isVisible)
          .slice(-100)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: String(
              element.innerText ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 180),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            disabled: Boolean(element.disabled),
            role: element.getAttribute("role"),
          })),
        videos: Array.from(document.querySelectorAll("video")).map(
          (video) => ({
            src: video.currentSrc || video.src || "",
            poster: video.poster || "",
            readyState: video.readyState,
            duration: Number.isFinite(video.duration)
              ? video.duration
              : null,
            visible: isVisible(video),
          })
        ),
        images: Array.from(document.querySelectorAll("img"))
          .filter(isVisible)
          .slice(-80)
          .map((image) => ({
            src: image.currentSrc || image.src || "",
            alt: image.alt || "",
          })),
      };
    });

    fs.writeFileSync(
      jsonPath,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (error) {
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ error: error.message }, null, 2),
      "utf8"
    );
  }

  try {
    await page.screenshot({
      path: pngPath,
      fullPage: true,
      timeout: 15000,
    });
  } catch (error) {
    console.warn(
      `   ⚠️ Could not save Flow screenshot: ${error.message}`
    );
  }

  console.log(`   🧾 Flow diagnostics saved: ${jsonPath}`);
  console.log(`   🖼️ Flow screenshot saved: ${pngPath}`);

  return { jsonPath, pngPath };
}

async function getFlowMediaSnapshot(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!element || !element.getClientRects().length) return false;

      const style = window.getComputedStyle(element);

      return (
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };

    const bodyText = document.body?.innerText || "";
    const normalizedBodyText = bodyText.replace(/\s+/g, " ");

    /*
     * Google Flow may display progress as:
     * play_circle
     * 3%
     *
     * That progress is not always exposed through an aria-busy
     * attribute or a standard progress element.
     */
    const progressTextDetected =
      /play_circle\s+\d{1,3}%/i.test(normalizedBodyText);

    const videos = Array.from(document.querySelectorAll("video")).map(
      (video, domIndex) => ({
        domIndex,
        src: video.currentSrc || video.src || "",
        poster: video.poster || "",
        visible: isVisible(video),
        readyState: video.readyState,
        duration: Number.isFinite(video.duration)
          ? video.duration
          : null,
      })
    );

    const images = Array.from(document.querySelectorAll("img"))
      .map((image, domIndex) =>
        isVisible(image)
          ? {
              domIndex,
              src: image.currentSrc || image.src || "",
              alt: image.alt || "",
              naturalWidth: image.naturalWidth || 0,
              naturalHeight: image.naturalHeight || 0,
            }
          : null
      )
      .filter(Boolean)
      .filter((image) => image.src);

    const containers = Array.from(
      document.querySelectorAll("flow-tile-container")
    );

    const videoTiles = Array.from(
      document.querySelectorAll("flow-video-tile")
    )
      .map((tile, domIndex) => {
        if (!isVisible(tile)) return null;

        const thumbnail = tile.querySelector(
          "img.thumbnail, img.image, img"
        );

        const thumbnailSrc = thumbnail
          ? thumbnail.currentSrc ||
            thumbnail.src ||
            thumbnail.getAttribute("src") ||
            ""
          : "";

        const tileVideos = Array.from(
          tile.querySelectorAll("video")
        ).map((video) => ({
          src: video.currentSrc || video.src || "",
          poster: video.poster || "",
        }));

        const videoSrc =
          tileVideos.map((video) => video.src).find(Boolean) || "";

        const poster =
          tileVideos.map((video) => video.poster).find(Boolean) || "";

        const assetId =
          tile.getAttribute("data-asset-id") ||
          tile.getAttribute("data-id") ||
          tile.id ||
          "";

        const container = tile.closest("flow-tile-container");

        const containerIndex = container
          ? containers.indexOf(container)
          : -1;

        /*
         * Stable signature: prefer an asset ID, then thumbnail/poster.
         * The video URL may only become available after a card exists.
         */
        let signature;

        if (assetId) {
          signature = `asset:${assetId}`;
        } else if (thumbnailSrc) {
          signature = `thumbnail:${thumbnailSrc}`;
        } else if (poster) {
          signature = `poster:${poster}`;
        } else if (videoSrc) {
          signature = `video:${videoSrc}`;
        } else {
          signature = `tile:${domIndex}`;
        }

        /*
         * Check the parent container as well as the video tile.
         * Flow's progress indicator may sit outside flow-video-tile.
         */
        const pendingSelector =
          "flow-pending-tile, [aria-busy='true'], " +
          "[role='progressbar'], progress";

        const statusElements = [
          ...tile.querySelectorAll(pendingSelector),
          ...(container
            ? [...container.querySelectorAll(pendingSelector)]
            : []),
        ];

        const pending = statusElements.some((element) => {
          if (!isVisible(element)) return false;

          if (
            element.matches(
              "flow-pending-tile, [aria-busy='true']"
            )
          ) {
            return true;
          }

          const value =
            element instanceof HTMLProgressElement
              ? element.value
              : Number(element.getAttribute("aria-valuenow"));

          const maximum =
            element instanceof HTMLProgressElement
              ? element.max
              : Number(
                  element.getAttribute("aria-valuemax") || 100
                );

          return (
            !Number.isFinite(value) ||
            !Number.isFinite(maximum) ||
            value < maximum
          );
        });

        const failed = Boolean(
          tile.querySelector(
            "flow-error-tile, .error-tile, .error-tile-content"
          ) ||
            container?.querySelector(
              "flow-error-tile, .error-tile, .error-tile-content"
            )
        );

        const usableSource =
          thumbnailSrc || videoSrc || poster;

        const hasUsableMedia =
          Boolean(usableSource) &&
          !usableSource.startsWith("data:image/svg") &&
          !usableSource.includes("placeholder");

        const containerText = String(
          container?.innerText || tile.innerText || ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200);

        const textProgressDetected =
          /play_circle\s+\d{1,3}%/i.test(
            containerText.replace(/\s+/g, " ")
          );

        return {
          kind: "video-tile",
          domIndex,
          containerIndex,
          identity: assetId,
          thumbnailSrc,
          videoSrc,
          poster,
          signature,
          pending: pending || textProgressDetected,
          failed,
          hasUsableMedia,
          complete:
            hasUsableMedia &&
            !pending &&
            !textProgressDetected &&
            !failed,
          text: containerText.slice(0, 160),
          containerText,
        };
      })
      .filter(Boolean);

    const globalBusy = Array.from(
      document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], progress'
      )
    ).some((element) => {
      if (!isVisible(element)) return false;

      if (element.matches('[aria-busy="true"]')) return true;

      const value =
        element instanceof HTMLProgressElement
          ? element.value
          : Number(element.getAttribute("aria-valuenow"));

      const maximum =
        element instanceof HTMLProgressElement
          ? element.max
          : Number(element.getAttribute("aria-valuemax") || 100);

      return (
        !Number.isFinite(value) ||
        !Number.isFinite(maximum) ||
        value < maximum
      );
    });

    const generationTextBusy =
      /\b(generating video|creating video|rendering video|processing video|in queue|queued|generation in progress)\b/i.test(
        bodyText
      );

    const downloadControlCount = Array.from(
      document.querySelectorAll('button, [role="button"]')
    )
      .filter(isVisible)
      .filter((element) =>
        /download/i.test(
          `${element.getAttribute("aria-label") || ""} ${
            element.getAttribute("title") || ""
          } ${element.innerText || ""}`
        )
      ).length;

    return {
      videos,
      videoTiles,
      images: images.map((image) => image.src),
      imageDetails: images,
      assetTiles: [],
      videoCount: videos.length,
      videoTileCount: videoTiles.length,
      assetTileCount: containers.filter(isVisible).length,
      downloadControlCount,
      visibleMediaCount:
        videos.filter((video) => video.visible).length +
        images.length,
      progressTextDetected,
      busy:
        globalBusy ||
        generationTextBusy ||
        progressTextDetected,
    };
  });
}

module.exports = {
  findVisibleLocator,
  captureFlowDiagnostics,
  getFlowMediaSnapshot,
};