# Avatar artwork

Assistant avatars use the MIT-licensed core of
[Open Mascot Studio](https://github.com/0oooh/open-mascot-studio),
Copyright 2026 0oooh, pinned to `b83ca3863f4e35424342d42538873af1bacddf9f`.
The bundled license and source provenance are in
`packages/ui/src/lib/assistant-avatar/vendor/open-mascot/`.
Yuri supplies its own configuration, pigments and twelve additional connected
geometric silhouettes; no Grok/xAI logos, extracted
application code or reference animation data are included. The upstream license
covers the contributed source; it does not grant third-party trademarks or designs.

Agent avatars are rendered locally with DiceBear (`@dicebear/core`, MIT).
The application imports only Bottts Neutral from `@dicebear/styles`.
SVG output retains DiceBear's attribution metadata.

- **Bottts Neutral** is [DiceBear's adaptation](https://www.dicebear.com/styles/bottts-neutral/)
  of **Bottts** by [Pablo Stanley](https://bottts.com/), free for personal and
  commercial use under the [original artwork's license](https://bottts.com/).

Bottts Neutral avatars use each Agent's badge color as a solid background. Avatars are deterministically
assembled, resized, and clipped for display; native surfaces use locally
rasterized PNG copies.
