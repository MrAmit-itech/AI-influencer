function resolveUserChoices(
  env = process.env,
  defaultAffiliateTag = (env.AMAZON_AFFILIATE_TAG || "yourtag-21").trim(),
) {
  const configuredMode = (env.VIDEO_MODE || "OPTION_A").trim().toUpperCase();
  const videoMode =
    configuredMode === "A" || configuredMode === "OPTION_A"
      ? "OPTION_A"
      : configuredMode === "B" || configuredMode === "OPTION_B"
        ? "OPTION_B"
        : null;

  if (!videoMode) {
    throw new Error(
      `Invalid VIDEO_MODE "${configuredMode}". Set it to OPTION_A or OPTION_B in .env.`,
    );
  }

  return { videoMode, affiliateTag: defaultAffiliateTag };
}

module.exports = { resolveUserChoices };
