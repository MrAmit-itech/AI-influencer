const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { escapeHtml, toHighResAmazonImage } = require("../src/phase1/utils");
const { buildAffiliateUrl } = require("../src/phase2/products");
const { resolveUserChoices } = require("../src/phase2/mode");
const flowDownloads = require("../src/phase2/flow/downloads");
const { FLOW_VIDEO_SETTINGS } = require("../src/phase2/flow/config");
const {
  findNewCompletedVideoTile,
} = require("../src/phase2/flow/media");
const { getFlowMediaSnapshot } = require("../src/phase2/flow/page");
const {
  FLOW_DOWNLOAD_TIMEOUT_MS,
  CLIP_COUNT,
} = require("../src/phase2/config");
const { clearGeneratedFolders } = require("../src/phase2/cleanup");
const {
  findUploadedProjectAsset,
  resetFlowPromptIngredients,
  waitForVisibleLocator,
} = require("../src/phase2/flow/ingredients");
const { chromium } = require("playwright");

test("Phase 1 helpers escape Telegram HTML and upgrade Amazon image sizes", () => {
  assert.equal(escapeHtml("<dress & coat>"), "&lt;dress &amp; coat&gt;");
  assert.equal(
    toHighResAmazonImage("https://example.com/item._SX300_.jpg"),
    "https://example.com/item._SL1200_.jpg",
  );
  assert.equal(toHighResAmazonImage(""), "");
});

test("affiliate links use the selected ASIN and tag", () => {
  assert.equal(
    buildAffiliateUrl("https://amazon.in/old", "B012345678", "fashion-21"),
    "https://www.amazon.in/dp/B012345678?tag=fashion-21",
  );
});

test("reel mode defaults to five-dress OPTION_A without prompting", () => {
  assert.deepEqual(resolveUserChoices({}, "fashion-21"), {
    videoMode: "OPTION_A",
    affiliateTag: "fashion-21",
  });
});

test("reel mode accepts OPTION_B and its short alias", () => {
  assert.equal(resolveUserChoices({ VIDEO_MODE: "option_b" }).videoMode, "OPTION_B");
  assert.equal(resolveUserChoices({ VIDEO_MODE: "b" }).videoMode, "OPTION_B");
});

test("invalid reel modes fail with actionable configuration guidance", () => {
  assert.throws(
    () => resolveUserChoices({ VIDEO_MODE: "OPTION_C" }),
    /Set it to OPTION_A or OPTION_B in \.env/,
  );
});

test("Flow download module receives its configured timeout", () => {
  assert.equal(typeof FLOW_DOWNLOAD_TIMEOUT_MS, "number");
  assert.ok(FLOW_DOWNLOAD_TIMEOUT_MS >= 10000);
  assert.equal(typeof flowDownloads.attemptFlowDownload, "function");
});

test("generated-folder cleanup removes contents but preserves folders", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-influencer-cleanup-"));
  const generatedFolder = path.join(tempRoot, "clips");
  fs.mkdirSync(path.join(generatedFolder, "nested"), { recursive: true });
  fs.writeFileSync(path.join(generatedFolder, "clip.mp4"), "clip");
  fs.writeFileSync(path.join(generatedFolder, "nested", "temp.txt"), "temp");

  try {
    clearGeneratedFolders([generatedFolder]);
    assert.deepEqual(fs.readdirSync(generatedFolder), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Flow video settings are centralized with the existing defaults", () => {
  assert.deepEqual(FLOW_VIDEO_SETTINGS, {
    generationMode: "Video",
    model: "Omni 1.1 Flash",
    ingredientMode: "Ingredients",
    aspectRatio: "9:16",
    resolution: "720p",
    duration: "4s",
    outputs: "x1",
  });
});

test("clip count is read from the environment configuration", () => {
  assert.equal(CLIP_COUNT, 2);
});

test("Flow locator polling supports scoped locators without page wait helpers", async () => {
  let lookups = 0;
  const visibleCandidate = {
    isVisible: async () => true,
    isEnabled: async () => true,
  };
  const pageOrScopedLocator = {
    locator: () => ({
      count: async () => {
        lookups += 1;
        return lookups > 1 ? 1 : 0;
      },
      nth: () => visibleCandidate,
    }),
  };

  const result = await waitForVisibleLocator(
    pageOrScopedLocator,
    ["button"],
    {},
    1000,
  );

  assert.equal(result, visibleCandidate);
  assert.ok(lookups > 1);
});

test("Flow character reuse finds an asset exposed as an option outside the picker pane", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section id="picker">
        <button>Upload media</button>
      </section>
      <div role="listbox">
        <button role="option" aria-label="Miss_Rashi.jpg" aria-selected="false">
          <img alt="Miss_Rashi.jpg" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
          <span>Miss_Rashi.jpg</span>
          <span>Image</span>
        </button>
      </div>
    `);

    const asset = await findUploadedProjectAsset(
      page,
      page.locator("#picker"),
      "Miss_Rashi.jpg",
    );
    assert.ok(asset);
    assert.match(await asset.innerText(), /Miss_Rashi\.jpg/);
  } finally {
    await browser.close();
  }
});

test("Flow prompt reset removes stale ingredient chips before the next clip", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <flow-base-prompt-box>
        <button aria-label="Ingredient" onclick="this.remove()">
          <img alt="Video ingredient image" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
        </button>
        <button aria-label="Ingredient" onclick="this.remove()">Old dress ingredient</button>
      </flow-base-prompt-box>
    `);

    await resetFlowPromptIngredients(page);
    assert.equal(
      await page.locator('flow-base-prompt-box button[aria-label="Ingredient"]').count(),
      0,
    );
  } finally {
    await browser.close();
  }
});

test("Flow generation ignores a new video tile until it is complete", () => {
  const baseline = {
    videoTileCount: 1,
    videoTiles: [{ signature: "clip-1" }],
  };
  const processingTile = {
    signature: "clip-2",
    pending: true,
    complete: false,
    failed: false,
  };
  const completedTile = {
    signature: "clip-2",
    pending: false,
    complete: true,
    failed: false,
  };

  assert.equal(
    findNewCompletedVideoTile(
      { videoTileCount: 2, videoTiles: [processingTile, baseline.videoTiles[0]] },
      baseline,
    ),
    null,
  );
  assert.equal(
    findNewCompletedVideoTile(
      { videoTileCount: 2, videoTiles: [completedTile, baseline.videoTiles[0]] },
      baseline,
    ),
    completedTile,
  );
});

test("Flow snapshot ignores a progress-style hover overlay after media is available", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        flow-tile-container, flow-video-tile, img { display: block; width: 100px; height: 100px; }
      </style>
      <flow-tile-container>
        <flow-video-tile>
          <img alt="Video thumbnail" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
          <div class="hover-overlay-has-progress-bar"></div>
        </flow-video-tile>
      </flow-tile-container>
    `);

    const snapshot = await getFlowMediaSnapshot(page);
    assert.equal(snapshot.videoTileCount, 1);
    assert.equal(snapshot.videoTiles[0].pending, false);
    assert.equal(snapshot.videoTiles[0].complete, true);
  } finally {
    await browser.close();
  }
});
