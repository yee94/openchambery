# Avatar artwork

This experimental worktree uses
[GrokBot Animation Anatomy](https://github.com/ArvinYin1/grokbot-animation-anatomy),
pinned to `debd41625da89b4c4fde43b3b1f0add6dc113c02`. Bundled files and provenance
are in `packages/ui/src/lib/assistant-avatar/vendor/grok-anatomy/`.

The upstream README says MIT, but contains no separate license file. It also
states that the animation recipes were extracted from Grok Bot, that underlying
design/data remain their owners' property, and that publication is for study and
research. Do not treat the MIT label as permission to distribute extracted data.
**This integration must not be released until source/data distribution rights
are confirmed or the data is replaced with independently authored recipes.**
Grok and x.ai trademarks belong to their owners; no logos or original app bundle
are included. This replaces the Open Mascot runtime; no old eye/motion engine is
mixed into the new renderer.

Yuri independently implements the documented solid / extrusion / loft geometry
and eye-surface seating pipeline, including contours absent from the article's
source. Non-sphere geometry is not claimed to be frame-identical to the original
application. The source player has one documented optional geometry callback;
its sphere projection, expressions, clip evaluator and state machine are retained.

Agent avatars are rendered locally with DiceBear (`@dicebear/core`, MIT).
The application imports only Bottts Neutral from `@dicebear/styles`.
SVG output retains DiceBear's attribution metadata.

- **Bottts Neutral** is [DiceBear's adaptation](https://www.dicebear.com/styles/bottts-neutral/)
  of **Bottts** by [Pablo Stanley](https://bottts.com/), free for personal and
  commercial use under the [original artwork's license](https://bottts.com/).

Bottts Neutral avatars use each Agent's badge color as a solid background. Avatars are deterministically
assembled, resized, and clipped for display; native surfaces use locally
rasterized PNG copies.
