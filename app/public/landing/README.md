# Landing page artwork

These original PNGs are copied from the supplied roll-up banner's local design
assets, without modifying their pixels:

- `sky.png`: `天空素材-去网格-20261014.png`
- `mascot.png`: `奶龙.png`, the transparent sword artwork matching `易拉宝.jpg`
- `models.png`: `图层 8.png`, the six model windows
- `hands.png`: `手.png`, the gloved hands and wooden table
- `providers.png`: `图层 13.png`, the dragon with Tripo / Blender logos
- `scene.png`: `图层 12.png`, the living-room workspace
- `cursor.png`: `图层 11.png`, the pointer overlay
- `composer.png`: `输入框.png`, the dark input panel
- `texture.png`: user-supplied red-chair-to-green-chair transparent artwork,
  copied unchanged from the attachment `codex-clipboard-e74e784d-c726-4941-9990-75116de13550.png`
- `batch.png`: user-supplied batch material editing before / after artwork,
  copied unchanged from the attachment `codex-clipboard-bddc3cb6-2c99-447d-b3c1-ff1772cb57ed.png`
- `retopology.png`: user-supplied dense-to-simplified chair mesh comparison,
  copied unchanged from the attachment `codex-clipboard-75591fba-2cad-4045-ae87-2608f0efc3c7.png`
- `animation.png`: user-supplied dragon rigging / walking pose comparison,
  copied unchanged from the attachment `codex-clipboard-288234bc-30f8-4de4-ad56-32e818105e18.png`

The page uses a CSS fade over the sky and keeps the mascot's original aspect
ratio. The mascot sits immediately below the ChatSpace wordmark, overlapping
its lower edge slightly, followed by the project input. The existing world
thumbnails and feature recordings remain unchanged.
The feature covers reuse these assets over a white-washed sky, replacing the
cover with a recording only during hover or an explicit playback toggle.

Typography is scoped to `app/src/pages/home.css`. The source PSD records the
heavy face as `FZLTTHK--GBK1-0` (方正兰亭特黑_GBK). `FZLTTHK.TTF` is copied
unchanged from the user-supplied `/Users/junwei/Downloads/FZLTTHK.TTF`; its
PostScript name matches the PSD. The page loads it directly through
`@font-face`, so visitors do not need a locally installed copy. Although the
font's metadata says `Regular` / weight 400, it contains the heavy outlines;
the CSS face is mapped to 900 to match the landing page's display styles.
`font-display: swap` preserves readable text while the font downloads.

Landing copy is selected from browser language preferences (`navigator.languages`,
or `navigator.language` when that list is unavailable). The first supported
Chinese or English preference wins; other languages fall back to English.
All Chinese variants use Simplified Chinese. The page responds to browser
`languagechange` events without resetting the project input or image attachments.
The header's 中文 / EN buttons override browser detection and save the choice
under `chatspace.homeLanguage:v1` in localStorage. A saved choice takes priority
on subsequent visits and browser language changes; switching still works for
the current visit if storage is blocked.
Copy lives in `app/src/pages/homeCopy.ts`; feature IDs, media and project links
are shared with the English version. Chinese headlines follow the supplied
banner's concise style and rotate 建模 / 展 UV / 拓扑 / 贴图 / 绑骨 / 动画.
The English cycle matches that order: Model / Unwrap / Retopo / Texture / Rig /
Animate (`Retopo` is the short form of retopologize).
