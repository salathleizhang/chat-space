/** Report actual remote canvas frames, never provider credentials or a synthetic modeling animation. */
export function desktopDisplayScript(session: string, origins: string[]): string {
  return `(() => {
  const session = ${JSON.stringify(session)}, origins = ${JSON.stringify(origins)};
  let last = '', preview;
  const thumbnail = document.createElement('canvas'); thumbnail.width = 640; thumbnail.height = 480;
  function send() {
    const connected = document.documentElement.classList.contains('noVNC_connected');
    if (connected) {
      // KasmVNC creates its display canvas without an id; the monitor widget is a different canvas.
      const canvas = Array.from(document.querySelectorAll('canvas'))
        .filter(c => c.id !== 'noVNC_multiMonitorWidget' && c.width > 0 && c.height > 0 && c.getBoundingClientRect().width > 0)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        try {
          const scale = Math.min(640 / canvas.width, 480 / canvas.height, 1);
          thumbnail.width = Math.max(1, Math.round(canvas.width * scale));
          thumbnail.height = Math.max(1, Math.round(canvas.height * scale));
          const context = thumbnail.getContext('2d');
          context.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
          const pixels = context.getImageData(0, 0, thumbnail.width, thumbnail.height).data;
          // RFB can be connected before the first framebuffer arrives. Do not
          // replace an actual desktop frame with that unpainted black canvas.
          let painted = false;
          for (let i = 0; i < pixels.length; i += 64) {
            if (pixels[i + 3] && (pixels[i] || pixels[i + 1] || pixels[i + 2])) { painted = true; break; }
          }
          if (painted) {
            const next = thumbnail.toDataURL('image/jpeg', 0.7);
            if (next.length <= 250000) preview = next;
          }
        } catch { preview = undefined; }
      }
    }
    const status = connected ? 'connected' : 'connecting';
    if (status === last && !preview) return;
    last = status;
    for (const origin of origins) parent.postMessage({ type: 'chatspace-blender-display', session, status, ...(preview ? { preview } : {}) }, origin);
  }
  new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const timer = setInterval(send, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  send();
})();`;
}

export function withDesktopDisplay(html: string, session: string): string {
  const script = `<script src="/desktop/${session}/__lease/display.js"></script>`;
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, script + "</head>") : script + html;
}
