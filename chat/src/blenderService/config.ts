export function readServiceSettings(env = process.env) {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
  const origin = (key: string) => {
    const url = new URL(required(key));
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`Invalid ${key}`);
    return url.origin;
  };
  const secret = required("BLENDER_SERVICE_SECRET"); if (secret.length < 32) throw new Error("BLENDER_SERVICE_SECRET too short");
  const build = required("BLENDER_SERVICE_BUILD");
  if (!/^sha256:[a-f0-9]{64}$/.test(build)) throw new Error("BLENDER_SERVICE_BUILD must pin customized image digest");
  const positive = (key: string, scale = 1) => { const raw = Number(required(key)), value = raw * scale; if (!Number.isSafeInteger(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`); return value; };
  return { secret, build, budgets: {
    ownerRunMs: positive("BLENDER_DAILY_OWNER_MINUTES", 60_000), globalRunMs: positive("BLENDER_DAILY_GLOBAL_MINUTES", 60_000),
    ownerModelCalls: positive("BLENDER_DAILY_OWNER_MODEL_CALLS"), globalModelCalls: positive("BLENDER_DAILY_GLOBAL_MODEL_CALLS"),
  }, database: required("BLENDER_SERVICE_DATABASE"), target: origin("BLENDER_LIVE_TARGET") + "/",
    desktopOrigin: origin("BLENDER_DESKTOP_ORIGIN"), pauseEnabled: env.BLENDER_PAUSE_ENABLED === "1",
    volcano: { accessKeyId: required("VOLC_ACCESSKEY"), secretKey: required("VOLC_SECRETKEY"), sessionToken: env.VOLC_SESSION_TOKEN,
      functionId: required("BLENDER_FUNCTION_ID"), imageInfoId: required("BLENDER_IMAGE_INFO_ID"), region: required("VOLC_REGION") },
    tos: { bucket: required("BLENDER_TOS_BUCKET"), endpoint: required("BLENDER_TOS_ENDPOINT"), region: required("VOLC_REGION"),
      accessKeyId: required("TOS_ACCESS_KEY"), accessKeySecret: required("TOS_SECRET_KEY"), stsToken: env.TOS_SESSION_TOKEN, secure: true },
  };
}
