const { notarize } = require("@electron/notarize");

/**
 * Notarize the signed app so Gatekeeper opens it without the "unidentified
 * developer" detour.
 *
 * An App Store Connect API key is the first choice: it does not expire the way
 * app-specific passwords do, and it is not tied to one person's Apple ID.
 * Failing that, an Apple ID and app-specific password from the environment,
 * and locally the `notarytool` keychain profile stored once with
 * `xcrun notarytool store-credentials`. SKIP_NOTARIZE=1 skips the wait while
 * iterating.
 */
module.exports = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin" || process.env.SKIP_NOTARIZE) return;
  console.log("  • notarizing (this takes a few minutes)");

  const appPath = `${appOutDir}/${packager.appInfo.productFilename}.app`;
  const {
    APPLE_API_KEY_PATH,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER,
    APPLE_ID,
    APPLE_PASSWORD,
    APPLE_TEAM_ID,
  } = process.env;

  if (APPLE_API_KEY_PATH && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    await notarize({
      tool: "notarytool",
      appPath,
      appleApiKey: APPLE_API_KEY_PATH,
      appleApiKeyId: APPLE_API_KEY_ID,
      appleApiIssuer: APPLE_API_ISSUER,
    });
  } else if (APPLE_ID && APPLE_PASSWORD && APPLE_TEAM_ID) {
    await notarize({
      tool: "notarytool",
      appPath,
      appleId: APPLE_ID,
      appleIdPassword: APPLE_PASSWORD,
      teamId: APPLE_TEAM_ID,
    });
  } else {
    await notarize({
      tool: "notarytool",
      appPath,
      keychainProfile: process.env.NOTARY_PROFILE || "omniagent",
    });
  }
};
