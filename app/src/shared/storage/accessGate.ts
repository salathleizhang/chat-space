/** 访问门禁：上线后防止陌生访客消耗供应商 API token，
    进入网站前需要答对一个问题；答对后记在浏览器里，不必重复回答。 */

const ACCESS_GATE_KEY = "chatspace.accessGate:v1";
const ACCESS_GATE_ANSWER = "tripothon";

/** 判断答案是否正确；大小写与首尾空格不敏感。 */
export function checkAccessGateAnswer(input: string): boolean {
  return input.trim().toLowerCase() === ACCESS_GATE_ANSWER;
}

/** 是否已经通过门禁（本浏览器记住）。localStorage 不可用时视为未通过，
    宁可多答一次也不能放过消耗 token 的可能。 */
export function hasPassedAccessGate(): boolean {
  try {
    return localStorage.getItem(ACCESS_GATE_KEY) === "ok";
  } catch {
    return false;
  }
}

/** 答对后调用：在浏览器里记住本次解锁。 */
export function passAccessGate(): void {
  try {
    localStorage.setItem(ACCESS_GATE_KEY, "ok");
  } catch {
    // 禁用 localStorage 时无法记住，本次会话内仍可继续使用。
  }
}
