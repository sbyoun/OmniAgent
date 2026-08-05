const { notarize } = require("@electron/notarize");

/**
 * Notarize the signed app so Gatekeeper opens it without the "unidentified
 * developer" detour.
 *
 * Locally this uses the `notarytool` keychain profile set up once with
 * `xcrun notarytool store-credentials`; CI has no keychain, so it falls back
 * to the Apple ID + app-specific password in the environment. Set
 * SKIP_NOTARIZE=1 for a quick unnotarized build while iterating.
 */
module.exports = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin" || process.env.SKIP_NOTARIZE) return;
  console.log("  • notarizing (this takes a few minutes)");

  const appPath = `${appOutDir}/${packager.appInfo.productFilename}.app`;
  const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (APPLE_ID && APPLE_PASSWORD && APPLE_TEAM_ID) {
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
