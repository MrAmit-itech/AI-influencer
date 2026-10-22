"use strict";

const path = require("path");

const { DIRS } = require("../config");

function ensureOutputDirectories() {
  Object.values(DIRS).forEach((dir) => {
    if (!require("fs").existsSync(dir)) {
      require("fs").mkdirSync(dir, { recursive: true });
    }
  });
}

function resolveGenerationArtifactPaths() {
  return {
    clipsDir: DIRS.clips,
    outputDir: DIRS.output,
    tempDir: DIRS.tempImages,
    finalClipPath: path.join(DIRS.output, "final_reel.mp4"),
  };
}

module.exports = {
  ensureOutputDirectories,
  resolveGenerationArtifactPaths,
};
