# AI Influencer

A human-guided fashion affiliate reel pipeline for Amazon India.

## Pipeline overview

1. **Phase 1 - product selection:** Playwright searches Amazon.in across configured fashion categories. Product cards are sent to a Telegram bot, where selecting five products saves their details to `selected_dresses.json`.
2. **Phase 2 - creative preparation:** Selected product images are downloaded. Gemini analyzes dress images, helps blur faces in product references, and generates video prompts.
3. **Google Flow - clip generation:** Playwright opens the saved Chrome profile, configures Flow, uploads reference images, generates clips, and downloads the video files.
4. **Assembly and delivery:** FFmpeg normalizes and joins clips into a vertical reel; Telegram delivers it with affiliate links.

After a successful Telegram delivery, generated files in `clips/`, `output/`, and `temp_images/` are cleared by default. Set `CLEANUP_AFTER_DELIVERY=false` in `.env` to keep them; files are also kept if Telegram delivery is not configured or fails.

## Code layout

- `phase1-scraper-bot.js` and `phase2-flow-generator.js` remain the command-line entry points.
- `src/phase1/` separates Amazon scraping, Telegram selection, shared state, and startup.
- `src/phase2/` separates configuration, product utilities, Gemini image/prompt work, Telegram delivery, and video assembly.
- `src/phase2/flow/` contains Flow page inspection, asset downloading, ingredient/settings management, and clip generation.
- `src/phase2/flow/config.js` contains the editable Google Flow video settings (mode, model, aspect ratio, resolution, duration, and output count).
- Set `CLIP_COUNT` in `.env` to control how many clips are generated (default: 5 if omitted).
- `src/phase2/flow/gemini-video-prompt.txt` contains the editable instruction sent to Gemini. Edit the prompt text directly and keep `{{dressTitle}}` and `{{count}}` where those values should be inserted.
- `setup-login.js` initializes the persistent Chrome profile used by Flow automation.

## Running

Install dependencies with `npm install`, configure the required values in the ignored `.env` file, then run `node phase1-scraper-bot.js` followed by `node phase2-flow-generator.js`. Set `CLIP_COUNT=2` in `.env` to generate two clips. `VIDEO_MODE=OPTION_A` (the default) uses one dress per clip; `VIDEO_MODE=OPTION_B` uses the first dress for all poses. Set `FLOW_TEST_ONE_CLIP=true` to generate just one test clip. Authenticate Google Flow once using `node setup-login.js`.

Generated media, browser profile data, dependencies, and secrets are local-only and excluded by `.gitignore`.
