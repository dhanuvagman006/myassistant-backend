const router = require("express").Router();
const remoteConfig = require("../config/remoteConfig");
const appUpdate = require("./appUpdate");
const agentCall = require("../agents/agentCall");
const db = require("../db");

// Live overrides saved by the admin panel (kv key remote_config_overrides):
// {features: {...}, announcement, forceUpdateBelow}. They sit on top of the
// static switchboard so a flag can be flipped for every installed app
// without a redeploy. Missing/broken row = no overrides, static file wins.
async function overrides() {
  try {
    const r = await db.query("SELECT v FROM kv WHERE k='remote_config_overrides'");
    return r.length ? JSON.parse(r[0].v) || {} : {};
  } catch (_) {
    return {};
  }
}

// Static switchboard (feature flags, announcements) merged with the
// dynamically uploaded APK metadata — an APK published via POST /admin/apk
// overrides the hardcoded version fields, so shipping an update is just
// one curl, no redeploy.
router.get("/", async (_req, res) => {
  const apk = appUpdate.readMeta();
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const o = await overrides();
  res.json({
    ...remoteConfig,
    ...(o.announcement !== undefined && { announcement: o.announcement }),
    ...(o.forceUpdateBelow !== undefined && { forceUpdateBelow: o.forceUpdateBelow }),
    // agent_calls is available whenever telephony is actually configured,
    // regardless of the static default — no redeploy needed to switch it on.
    features: {
      ...remoteConfig.features,
      ...(o.features || {}),
      agent_calls: agentCall.enabled(),
    },
    ...(apk && {
      latestVersionCode: apk.versionCode,
      latestVersionName: apk.versionName,
      changelog: apk.changelog?.length ? apk.changelog : remoteConfig.changelog,
      apkUrl: base ? `${base}/app/latest.apk` : null,
      apkSha256: apk.sha256,
      apkSize: apk.size,
    }),
  });
});

module.exports = router;
module.exports.overrides = overrides;
