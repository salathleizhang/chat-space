/** 共用工具的本机配置错误，在公开网站上应指向网站管理员。 */
export function browserErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/chat\/\.env/.test(message)) return message;
  const providers: Record<string, string> = {
    WORLDLABS_KEY: "World Labs", TRIPO_KEY: "Tripo3D",
    VOLC_KEY: "火山方舟", HUNYUAN_KEY: "混元",
  };
  const key = Object.keys(providers).find(key => message.includes(key));
  return key ? `该网站尚未配置 ${providers[key]}（${key}），需要网站管理员启用服务。` : message;
}
