"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");

try {
  require("dotenv").config({
    path: path.join(PROJECT_ROOT, ".env"),
  });
} catch (_) {}

const { DIRS } = require("../config");

const API_BASE_URL = "https://api.aimusicapi.ai/api/v1/producer";
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
]);

const CATEGORY_PROMPTS = {
  ethnic:
    "Original instrumental Indian fashion reel soundtrack, elegant modern Indian fusion, subtle tabla-inspired percussion, warm strings, graceful celebratory mood, polished contemporary fashion editorial, no vocals, no lyrics.",

  western:
    "Original instrumental upbeat modern fashion reel soundtrack, chic contemporary pop groove, stylish light electronic percussion, clean bass, confident runway energy, polished editorial production, no vocals, no lyrics.",

  party:
    "Original instrumental glamorous party fashion reel soundtrack, energetic stylish electronic pop beat, sparkling synth textures, confident nightlife runway mood, punchy rhythm, polished modern production, no vocals, no lyrics.",

  casual:
    "Original instrumental relaxed fashion reel soundtrack, bright feel-good indie pop groove, light percussion, warm guitar and soft synth textures, effortless everyday style, no vocals, no lyrics.",

  coord:
    "Original instrumental contemporary fashion reel soundtrack, smooth rhythmic pop groove, chic minimal electronic textures, clean bass, sophisticated upbeat mood, no vocals, no lyrics.",

  default:
    "Original instrumental soundtrack for a premium women's fashion Instagram Reel, modern stylish pop groove, elegant upbeat mood, tasteful percussion, polished fashion editorial production, no vocals, no lyrics.",
};

function isEnabled(name, fallback = true) {
  const value = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();

  if (!value) return fallback;

  return ["true", "1", "yes", "on"].includes(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureValidFile(filePath, minimumSize = 1024) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (fs.statSync(filePath).size < minimumSize) {
    throw new Error(`File is unexpectedly small: ${filePath}`);
  }
}

function getVideoDurationSeconds(videoPath) {
  const result = spawnSync(
    ffmpegPath || "ffmpeg",
    ["-hide_banner", "-i", videoPath],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);

  if (!match) {
    throw new Error("Could not determine the final Reel duration.");
  }

  const duration =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Invalid final Reel duration.");
  }

  return duration;
}

function buildMusicPrompt(category) {
  const selectedCategory = String(category || "default")
    .trim()
    .toLowerCase();

  return CATEGORY_PROMPTS[selectedCategory] || CATEGORY_PROMPTS.default;
}

async function apiRequest(url, options = {}) {
  const apiKey = String(process.env.AIMUSICAPI_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error("AIMUSICAPI_API_KEY is not configured.");
  }

  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(
      Number(process.env.MUSIC_API_REQUEST_TIMEOUT_MS) || 30000,
    ),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const responseText = await response.text();

  let data = {};

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (_) {
    throw new Error(
      `Music API returned a non-JSON response (HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Music API HTTP ${response.status}: ${
        data.message || data.error || responseText.slice(0, 250)
      }`,
    );
  }

  return data;
}

function findAudioUrl(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioUrl(item, depth + 1);
      if (found) return found;
    }

    return null;
  }

  const possibleKeys = [
    "audio_url",
    "audioUrl",
    "music_url",
    "musicUrl",
    "download_url",
    "downloadUrl",
  ];

  for (const key of possibleKeys) {
    const valueAtKey = value[key];

    if (typeof valueAtKey === "string" && /^https?:\/\//i.test(valueAtKey)) {
      return valueAtKey;
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "image_url" || key === "video_url") {
      continue;
    }

    if (nested && typeof nested === "object") {
      const found = findAudioUrl(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

async function generateAiMusic(category, outputAudioPath) {
  const prompt = buildMusicPrompt(category);

  console.log("🎵 Requesting a new AI-generated instrumental track...");
  console.log(`🎨 Music category: ${category || "default"}`);

  const created = await apiRequest(`${API_BASE_URL}/create`, {
    method: "POST",
    body: JSON.stringify({
      task_type: "create_music",
      mv: "FUZZ-2.0",
      sound: prompt,
      make_instrumental: true,
      title: `Fashion Reel ${Date.now()}`,
    }),
  });

  const taskId = created.task_id || created.data?.task_id;

  if (!taskId) {
    throw new Error("Music API did not return a task_id.");
  }

  console.log(`🎼 Music generation task created: ${taskId}`);

  const pollIntervalMs = Math.max(
    5000,
    Number(process.env.MUSIC_API_POLL_INTERVAL_MS) || 7000,
  );

  const maxWaitMs = Math.max(
    pollIntervalMs,
    Number(process.env.MUSIC_API_MAX_WAIT_MS) || 180000,
  );

  const deadline = Date.now() + maxWaitMs;
  let audioUrl = null;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const task = await apiRequest(
      `${API_BASE_URL}/task/${encodeURIComponent(taskId)}`,
      { method: "GET" },
    );

    const status = String(task.status || task.state || "").toUpperCase();

    console.log(`🎼 Music generation status: ${status || "UNKNOWN"}`);

    audioUrl = findAudioUrl(task);

    if (["FAILED", "FAILURE", "ERROR"].includes(status)) {
      throw new Error(task.message || "AI music generation failed.");
    }

    if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status) && audioUrl) {
      break;
    }

    if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status) && !audioUrl) {
      throw new Error(
        "Music generation completed, but no audio URL was returned.",
      );
    }
  }

  if (!audioUrl) {
    throw new Error("Timed out waiting for AI-generated music.");
  }

  console.log("⬇️ Downloading generated music...");

  const response = await fetch(audioUrl, {
    signal: AbortSignal.timeout(
      Number(process.env.MUSIC_DOWNLOAD_TIMEOUT_MS) || 60000,
    ),
  });

  if (!response.ok) {
    throw new Error(`Music download failed: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length < 1024) {
    throw new Error("Downloaded music file is too small.");
  }

  fs.writeFileSync(outputAudioPath, bytes);
  ensureValidFile(outputAudioPath);

  console.log(`✅ AI music downloaded: ${outputAudioPath}`);

  return outputAudioPath;
}

function findFallbackTrack(category) {
  const musicRoot = path.resolve(__dirname);
  const folders = [
    path.join(musicRoot, String(category || "default")),
    path.join(musicRoot, "default"),
  ];

  for (const folder of [...new Set(folders)]) {
    if (!fs.existsSync(folder)) continue;

    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => path.join(folder, entry.name))
      .filter((filePath) => {
        try {
          ensureValidFile(filePath);
          return true;
        } catch (_) {
          return false;
        }
      })
      .sort();

    if (files.length > 0) {
      console.log(`🎵 Using fallback music: ${files[0]}`);
      return files[0];
    }
  }

  return null;
}

function mixMusicIntoVideo(videoPath, audioPath, category) {
  ensureValidFile(videoPath);
  ensureValidFile(audioPath);

  fs.mkdirSync(DIRS.output, { recursive: true });

  const duration = getVideoDurationSeconds(videoPath);
  const fadeDuration = Math.min(1.5, duration / 4);
  const fadeOutStart = Math.max(0, duration - fadeDuration);
  const volume = Math.min(
    1,
    Math.max(0.01, Number(process.env.BACKGROUND_MUSIC_VOLUME) || 0.22),
  );

  const outputPath = path.join(
    DIRS.output,
    `final_reel_with_music_${Date.now()}.mp4`,
  );

  const audioFilter = [
    `volume=${volume}`,
    `afade=t=in:st=0:d=${fadeDuration.toFixed(3)}`,
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}`,
  ].join(",");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",

    "-i",
    videoPath,

    "-stream_loop",
    "-1",
    "-i",
    audioPath,

    "-filter_complex",
    `[1:a]${audioFilter}[music]`,

    "-map",
    "0:v:0",

    "-map",
    "[music]",

    "-c:v",
    "copy",

    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-t",
    duration.toFixed(3),

    "-movflags",
    "+faststart",

    outputPath,
  ];

  try {
    console.log(`🎚️ Mixing background music at ${volume} volume...`);

    execFileSync(ffmpegPath || "ffmpeg", args, {
      stdio: "inherit",
      windowsHide: true,
    });

    ensureValidFile(outputPath);

    console.log(`✅ Music-enhanced Reel created: ${outputPath}`);

    return outputPath;
  } catch (error) {
    try {
      if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath, { force: true });
      }
    } catch (_) {}

    throw new Error(`FFmpeg audio mixing failed: ${error.message}`);
  }
}

async function addBackgroundMusic(videoPath, options = {}) {
  ensureValidFile(videoPath);

  const category = String(options.category || "default")
    .trim()
    .toLowerCase();

  if (!isEnabled("ENABLE_BACKGROUND_MUSIC", true)) {
    console.log("⏭️ Background music disabled by configuration.");

    return {
      videoPath,
      source: "disabled",
      category,
    };
  }

  fs.mkdirSync(DIRS.output, { recursive: true });

  const generatedAudioPath = path.join(
    DIRS.output,
    `ai_music_${Date.now()}.mp3`,
  );

  let audioPath = null;
  let source = "none";

  try {
    if (String(process.env.AIMUSICAPI_API_KEY || "").trim()) {
      try {
        audioPath = await generateAiMusic(category, generatedAudioPath);

        source = "ai";
      } catch (error) {
        console.warn(`⚠️ AI music generation failed: ${error.message}`);

        if (fs.existsSync(generatedAudioPath)) {
          fs.rmSync(generatedAudioPath, { force: true });
        }
      }
    } else {
      console.warn(
        "⚠️ AIMUSICAPI_API_KEY is missing; checking fallback music.",
      );
    }

    if (!audioPath && isEnabled("MUSIC_FALLBACK_ENABLED", true)) {
      audioPath = findFallbackTrack(category);

      if (audioPath) {
        source = "fallback";
      }
    }

    if (!audioPath) {
      console.warn("⚠️ No generated or valid fallback audio is available.");

      console.warn(
        "ℹ️ Continuing with the original Reel; Telegram delivery will proceed.",
      );

      return {
        videoPath,
        source: "none",
        category,
      };
    }

    try {
      const finalVideoPath = mixMusicIntoVideo(videoPath, audioPath, category);

      return {
        videoPath: finalVideoPath,
        source,
        category,
      };
    } catch (error) {
      console.error(`⚠️ Audio mixing failed: ${error.message}`);

      console.warn("ℹ️ Returning the original post-processed Reel.");

      return {
        videoPath,
        source: "none",
        category,
      };
    }
  } finally {
    if (source === "ai" && fs.existsSync(generatedAudioPath)) {
      try {
        fs.rmSync(generatedAudioPath, { force: true });
      } catch (error) {
        console.warn(
          `⚠️ Could not remove temporary generated audio: ${error.message}`,
        );
      }
    }
  }
}

module.exports = {
  addBackgroundMusic,
  generateAiMusic,
  mixMusicIntoVideo,
  findFallbackTrack,
  buildMusicPrompt,
};
