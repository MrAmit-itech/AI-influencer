'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

try {
  require('dotenv').config({
    path: path.join(PROJECT_ROOT, '.env'),
  });
} catch (_) {
  // Environment may already be loaded by the main application.
}

const { DIRS } = require('./config');

let cachedCaptionModels = null;

const FALLBACK_CAPTIONS = {
  ethnic: [
    { headline: 'A little festive magic', subtitle: 'Elegance for your next celebration' },
    { headline: 'The details say it all', subtitle: 'A timeless style moment' },
    { headline: 'Tradition, with a fresh feel', subtitle: 'Grace in every move' },
    { headline: 'Your festive look, sorted', subtitle: 'Which detail caught your eye?' },
    { headline: 'Save this look for later', subtitle: 'Your next outfit inspiration' },
  ],
  western: [
    { headline: 'This look deserves a twirl', subtitle: 'A fresh style moment' },
    { headline: 'Simple. Chic. Confident.', subtitle: 'Effortless outfit inspiration' },
    { headline: 'The little details', subtitle: 'Make all the difference' },
    { headline: 'Would you wear this?', subtitle: 'Make the look your own' },
    { headline: 'Save this look for later', subtitle: 'An outfit worth revisiting' },
  ],
  party: [
    { headline: 'A little main-character energy', subtitle: 'Ready for your next night out' },
    { headline: 'Let the look do the talking', subtitle: 'A little glam goes a long way' },
    { headline: 'Your moment in the spotlight', subtitle: 'Confidence from every angle' },
    { headline: 'The plans can wait', subtitle: 'First, pick the look' },
    { headline: 'Keep this party look', subtitle: 'Save it for your next plan' },
  ],
  casual: [
    { headline: 'Everyday, with a little extra', subtitle: 'Easy outfit inspiration' },
    { headline: 'An effortless kind of look', subtitle: 'Comfort meets confidence' },
    { headline: 'Less fuss, more style', subtitle: 'Made for everyday moments' },
    { headline: 'Your next go-to look?', subtitle: 'Would you style it this way?' },
    { headline: 'Save this everyday look', subtitle: 'One to come back to' },
  ],
  coord: [
    { headline: 'One set, a whole look', subtitle: 'Co-ords made easy' },
    { headline: 'A match made in style', subtitle: 'Clean, chic, effortless' },
    { headline: 'Put-together in a moment', subtitle: 'No-fuss outfit inspiration' },
    { headline: 'A co-ord kind of day', subtitle: 'Would you wear this set?' },
    { headline: 'Save this matching look', subtitle: 'Your next outfit idea' },
  ],
  default: [
    { headline: 'A fresh little style moment', subtitle: 'Outfit inspiration, unlocked' },
    { headline: 'The details make the difference', subtitle: 'Simple style, done well' },
    { headline: 'A look to make your own', subtitle: 'What would you pair with it?' },
    { headline: 'Consider this your outfit inspo', subtitle: 'A fresh take on style' },
    { headline: 'Save this look for later', subtitle: 'More style inspiration' },
  ],
};

function isEnabled(name, defaultValue = true) {
  const value = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();

  if (!value) return defaultValue;

  return ['true', '1', 'yes', 'on'].includes(value);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function oneLine(value, maxLength) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// Product information is used locally for category classification.
// Product titles are NEVER sent to Gemini.
function productText(product) {
  if (!product || typeof product !== 'object') {
    return String(product || '').toLowerCase();
  }

  return [
    product.category,
    product.title,
    product.name,
    product.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function classifyProduct(product) {
  const text = productText(product);

  if (/\b(co[\s-]?ord|coordinated set|two[- ]piece set|matching set)\b/.test(text)) {
    return 'coord';
  }

  if (/\b(saree|sari|kurti|kurta|lehenga|sharara|salwar|anarkali|ethnic|dupatta|churidar|festive|traditional)\b/.test(text)) {
    return 'ethnic';
  }

  if (/\b(party|sequin|gown|cocktail|bodycon|evening wear|glam|sparkle)\b/.test(text)) {
    return 'party';
  }

  if (/\b(casual|daily wear|t[ -]?shirt|tshirt|jeans|everyday|lounge|basic top|casual top)\b/.test(text)) {
    return 'casual';
  }

  if (/\b(dress|floral|midi|maxi|mini|western|jumpsuit)\b/.test(text)) {
    return 'western';
  }

  return 'default';
}

function detectCategory(products) {
  const counts = {
    ethnic: 0,
    western: 0,
    party: 0,
    casual: 0,
    coord: 0,
    default: 0,
  };

  for (const product of (Array.isArray(products) ? products : [])) {
    counts[classifyProduct(product)] += 1;
  }

  const priority = [
    'ethnic',
    'coord',
    'party',
    'western',
    'casual',
    'default',
  ];

  return priority.reduce(
    (best, key) => counts[key] > counts[best] ? key : best,
    'default',
  );
}

function getVideoDurationSeconds(videoPath, fallbackSeconds) {
  const result = spawnSync(
    ffmpegPath || 'ffmpeg',
    ['-hide_banner', '-i', videoPath],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    },
  );

  const diagnostic =
    `${result.stdout || ''}\n${result.stderr || ''}`;

  const match = diagnostic.match(
    /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/,
  );

  if (match) {
    const duration =
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]);

    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  }

  console.warn(
    `⚠️ Could not read video duration; using ${fallbackSeconds}s as fallback.`,
  );

  return fallbackSeconds;
}

function buildSegmentContexts(products, videoMode, segmentCount) {
  const list = Array.isArray(products) ? products : [];

  return Array.from({ length: segmentCount }, (_, index) => {
    let productIndex = 0;

    if (videoMode !== 'OPTION_B' && list.length > 1) {
      productIndex = Math.min(
        list.length - 1,
        Math.floor(index * list.length / segmentCount),
      );
    }

    const category = classifyProduct(list[productIndex] || {});

    return {
      segment: index + 1,
      role: index === 0
        ? (segmentCount === 1
          ? 'single full-video hook'
          : 'opening hook')
        : index === segmentCount - 1
          ? 'closing engagement line'
          : 'short mid-video fashion hook',
      category,
    };
  });
}

function localFallbackCaptions(contexts) {
  return contexts.map((context, index) => {
    const set =
      FALLBACK_CAPTIONS[context.category] ||
      FALLBACK_CAPTIONS.default;

    const slot = contexts.length === 1
      ? 0
      : Math.round(index * 4 / (contexts.length - 1));

    return {
      headline: set[slot].headline,
      subtitle: set[slot].subtitle,
    };
  });
}

function parseCaptionJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed.captions;

  if (!Array.isArray(rows)) {
    throw new Error('Gemini did not return a captions array.');
  }

  return rows.map((item) => ({
    headline: oneLine(item.headline || item.title, 38),
    subtitle: oneLine(item.subtitle || item.subline, 48),
  }));
}

async function getCaptionModels(apiKey) {
  const override = String(
    process.env.GEMINI_CAPTION_MODEL || '',
  ).trim();

  if (override) return [override];
  if (cachedCaptionModels) return cachedCaptionModels;

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        headers: { 'x-goog-api-key': apiKey },
      },
    );

    const data = await response.json();

    if (response.ok && Array.isArray(data.models)) {
      const models = data.models
        .filter((model) =>
          model.supportedGenerationMethods?.includes('generateContent'),
        )
        .map((model) => model.name.replace(/^models\//, ''))
        .filter((name) =>
          /flash|lite/i.test(name) &&
          !/tts|audio|imagen|veo|embedding/i.test(name),
        );

      models.sort((a, b) => {
        const score = (name) =>
          /flash/i.test(name) ? 0 : /lite/i.test(name) ? 1 : 2;

        return score(a) - score(b);
      });

      if (models.length) {
        cachedCaptionModels = models.slice(0, 4);
        return cachedCaptionModels;
      }
    }
  } catch (error) {
    console.warn(
      `⚠️ Gemini model discovery failed: ${error.message}`,
    );
  }

  cachedCaptionModels = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
  ];

  return cachedCaptionModels;
}

async function generateAiCaptions(products, videoMode, segmentCount) {
  const apiKey = String(
    process.env.GEMINI_API_KEY || '',
  ).trim();

  const contexts = buildSegmentContexts(
    products,
    videoMode,
    segmentCount,
  );

  const fallback = localFallbackCaptions(contexts);

  if (!apiKey) {
    console.warn(
      '⚠️ GEMINI_API_KEY is missing; using category-based fallback captions.',
    );

    return {
      captions: fallback,
      source: 'fallback',
      contexts,
    };
  }

  // Only segment number, role, and category reach Gemini.
  // Titles, URLs, ASINs, prices, and brand names are not included.
  const prompt = `You are an experienced fashion-film creative director and Instagram Reels copywriter for an Indian women's fashion account.

Create exactly ${segmentCount} elegant, catchy on-screen caption pairs for one vertical 9:16 outfit showcase.

Return only JSON in this shape:
{"captions":[{"headline":"...","subtitle":"..."}]}

Creative direction:
- Base the wording ONLY on the provided category and segment role.
- Do not ask for or invent details about the individual garment.
- Make each caption feel editorial, polished, current, and human.
- Use sentence case or tasteful title case, not all caps.
- Headline: ideally 3–7 words, maximum 38 characters.
- Subtitle: one short supporting phrase, maximum 48 characters.
- No hashtags, prices, brands, product names, product titles, quotation marks, or extra fields.
- Avoid clichés such as "must-have", "slay", and "level up".
- The opening should hook attention.
- Middle lines should suit the fashion mood.
- The closing line should invite a natural response or saving the look.
- Keep the model and dress as the visual focus.
- These are brief visual overlays, not a full Instagram post caption.
- Return exactly ${segmentCount} caption objects.

Segment context (category and role ONLY):
${JSON.stringify(contexts)}`;

  const models = await getCaptionModels(apiKey);

  for (const model of models.slice(0, 3)) {
    try {
      console.log(
        `🤖 Generating category-only fashion captions with Gemini (${model})...`,
      );

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.9,
              maxOutputTokens: 700,
            },
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        console.warn(
          `⚠️ Gemini caption call failed (${model}): ` +
          `${data.error?.message || `HTTP ${response.status}`}`,
        );
        continue;
      }

      const output = (
        data.candidates?.[0]?.content?.parts || []
      )
        .map((part) => part.text || '')
        .join('\n')
        .trim();

      const captions = parseCaptionJson(output);

      if (
        captions.length !== segmentCount ||
        captions.some((item) => !item.headline || !item.subtitle)
      ) {
        throw new Error(
          `Expected ${segmentCount} complete caption pairs; ` +
          `received ${captions.length}.`,
        );
      }

      console.log('✅ Gemini captions generated using categories only:');

      captions.forEach((caption, index) => {
        console.log(
          `   ${index + 1}. ${caption.headline} — ${caption.subtitle}`,
        );
      });

      return {
        captions,
        source: 'gemini',
        contexts,
      };
    } catch (error) {
      console.warn(
        `⚠️ Caption generation failed using ${model}: ${error.message}`,
      );
    }
  }

  console.warn(
    '⚠️ Gemini unavailable; using local fallback captions.',
  );

  return {
    captions: fallback,
    source: 'fallback',
    contexts,
  };
}

async function createCaptionPng(destination, headline, subtitle) {
  const safeHeadline = escapeXml(headline);
  const safeSubtitle = escapeXml(subtitle);

  // Transparent canvas: no dark banner behind the text.
  // Fashion-editorial serif headline, moderate boldness, and a soft outline.
  // Kept near the top to reduce overlap with the model's face and dress.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="1080" height="1920"
       viewBox="0 0 1080 1920"
       xmlns="http://www.w3.org/2000/svg">
    <g text-anchor="middle"
       paint-order="stroke fill"
       stroke-linejoin="round">
      <text x="540" y="133"
            font-family="Georgia, 'Palatino Linotype', serif"
            font-size="43"
            font-weight="700"
            font-style="italic"
            letter-spacing="0.3"
            fill="#FFF8EF"
            stroke="#17120E"
            stroke-opacity="0.62"
            stroke-width="3.2">${safeHeadline}</text>

      <text x="540" y="177"
            font-family="Arial, Helvetica, sans-serif"
            font-size="19"
            font-weight="700"
            letter-spacing="1.3"
            fill="#F5D7A2"
            stroke="#17120E"
            stroke-opacity="0.58"
            stroke-width="2.4">${safeSubtitle}</text>

      <path d="M 505 201 L 575 201"
            stroke="#E8C99A"
            stroke-opacity="0.9"
            stroke-width="2"
            fill="none"/>
    </g>
  </svg>`;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(destination);
}

function ensureValidVideo(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video input was not found: ${filePath}`);
  }

  if (fs.statSync(filePath).size < 1024) {
    throw new Error(
      `Video input is unexpectedly small: ${filePath}`,
    );
  }
}

async function postProcessReel(inputVideoPath, options = {}) {
  ensureValidVideo(inputVideoPath);

  const products = Array.isArray(options.products)
    ? options.products
    : [];

  const videoMode = options.videoMode || 'OPTION_A';
  const primaryCategory = detectCategory(products);

  const overlayEnabled = isEnabled(
    'ENABLE_TEXT_OVERLAY',
    true,
  );

  if (!overlayEnabled) {
    console.log(
      '⏭️ Post-processing disabled; using the stitched Reel as-is.',
    );

    return {
      videoPath: inputVideoPath,
      category: primaryCategory,
      captionSource: 'none',
    };
  }

  fs.mkdirSync(DIRS.output, { recursive: true });
  fs.mkdirSync(DIRS.clips, { recursive: true });

  const fallbackDuration =
    videoMode === 'OPTION_B'
      ? 20
      : Math.max(4, products.length * 4);

  const duration = getVideoDurationSeconds(
    inputVideoPath,
    fallbackDuration,
  );

  const segmentCount = Math.max(
    1,
    Math.min(8, Math.ceil(duration / 4)),
  );

  const generated = overlayEnabled
    ? await generateAiCaptions(
        products,
        videoMode,
        segmentCount,
      )
    : {
        captions: [],
        source: 'none',
        contexts: [],
      };

  const timestamp = Date.now();

  const outputPath = path.join(
    DIRS.output,
    `final_reel_enhanced_${timestamp}.mp4`,
  );

  const ffmpeg = ffmpegPath || 'ffmpeg';

  const args = [
    '-y',
    '-hide_banner',
    '-stats_period', '1',
    '-loglevel', 'warning',
    '-i', inputVideoPath,
  ];

  const filters = [];
  const overlayFiles = [];
  let videoLabel = '0:v';

  const segmentDuration =
    duration / Math.max(1, generated.captions.length || 1);

  if (overlayEnabled) {
    for (
      let index = 0;
      index < generated.captions.length;
      index += 1
    ) {
      const caption = generated.captions[index];

      const overlayPath = path.join(
        DIRS.clips,
        `ai_caption_${timestamp}_${index + 1}.png`,
      );

      await createCaptionPng(
        overlayPath,
        caption.headline,
        caption.subtitle,
      );

      overlayFiles.push(overlayPath);

      const inputIndex = 1 + index;

      args.push(
        '-loop', '1',
        '-framerate', '30',
        '-i', overlayPath,
      );

      const outputLabel = `captioned${index}`;
      const start = index * segmentDuration;
      const end = Math.min(
        duration,
        (index + 1) * segmentDuration - 0.025,
      );

      filters.push(
        `[${videoLabel}][${inputIndex}:v]` +
        `overlay=0:0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'` +
        `[${outputLabel}]`,
      );

      videoLabel = outputLabel;
    }
  } else {
    filters.push('[0:v]null[vout]');
    videoLabel = 'vout';
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoLabel}]`,
  );

  args.push('-map', '0:a?');

  args.push(
    '-t', duration.toFixed(3),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
  );

  args.push('-c:a', 'aac');

  args.push(
    '-movflags',
    '+faststart',
    outputPath,
  );

  try {
    console.log(
      `🎬 Rendering ${generated.captions.length} ` +
      `${generated.source === 'gemini' ? 'AI-generated' : 'fallback'} ` +
      `caption overlay(s) across ${duration.toFixed(1)} seconds.`,
    );

    execFileSync(ffmpeg, args, {
      stdio: 'inherit',
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      `FFmpeg post-processing failed: ${error.message}`,
    );
  } finally {
    for (const overlayPath of overlayFiles) {
      if (fs.existsSync(overlayPath)) {
        fs.rmSync(overlayPath, { force: true });
      }
    }
  }

  ensureValidVideo(outputPath);

  console.log(`✅ Enhanced Reel created: ${outputPath}`);
  console.log(
    `✍️ Caption source: ${generated.source}. ` +
    'Gemini input contains categories and segment roles only.',
  );

  return {
    videoPath: outputPath,
    category: primaryCategory,
    captionSource: generated.source,
    captions: generated.captions,
  };
}

module.exports = {
  postProcessReel,
  detectCategory,
  generateAiCaptions,
};