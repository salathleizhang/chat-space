/** Served on the authenticated desktop origin. No interval: only user input keeps an editor active. */
export const DESKTOP_ACTIVITY_SCRIPT = `(() => {
  const url = new URL("activity", document.currentScript.src);
  let nextAt = 0;
  function activity(event) {
    if (!event.isTrusted || (event.type === "pointermove" && !event.buttons)) return;
    const now = Date.now();
    if (now < nextAt) return;
    nextAt = now + 10000;
    void fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store", keepalive: true }).catch(() => {});
  }
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    window.addEventListener(type, activity, { capture: true, passive: true });
  }
})();`;

export function withDesktopActivity(html: string, session: string): string {
  const script = `<script src="/desktop/${session}/__lease/activity.js"></script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, script + "</body>") : html + script;
}
