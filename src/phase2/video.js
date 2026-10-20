const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { DIRS } = require("./config");

function stitchClipsToReel(clipPaths) {
  console.log(
    "\n🎞️ Stitching 5 clips into a 20-second 1080x1920 Reel via FFmpeg...",
  );
  const bin = ffmpegPath || "ffmpeg";
  const finalReelPath = path.join(DIRS.output, `final_reel_${Date.now()}.mp4`);
  const concatListPath = path.join(DIRS.clips, "filelist.txt");
  const normalizedPaths = clipPaths.map((clipPath, idx) => {
    const normPath = path.join(DIRS.clips, `norm_clip_${idx + 1}.mp4`);
    execFileSync(
      bin,
      [
        "-y",
        "-i",
        clipPath,
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p",
        "-t",
        "4",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-an",
        normPath,
      ],
      { stdio: "ignore" },
    );
    return normPath;
  });
  const fileListContent = normalizedPaths
    .map((p) => `file '${p.replace(/\\/g, "/")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, fileListContent, "utf8");
  execFileSync(
    bin,
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      finalReelPath,
    ],
    { stdio: "ignore" },
  );
  console.log(`🎉 20-Second Reel created: ${finalReelPath}`);
  return finalReelPath;
}

module.exports = { stitchClipsToReel };
