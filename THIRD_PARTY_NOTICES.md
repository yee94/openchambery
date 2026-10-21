# Avatar artwork

Generated avatars are rendered locally with DiceBear (`@dicebear/core`, MIT).
The application imports only the Gaze and Bottts Neutral style definitions from
`@dicebear/styles`. SVG output retains DiceBear's attribution metadata.

- **Gaze** by [DiceBear](https://www.dicebear.com/styles/gaze/), licensed under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- **Bottts Neutral** is [DiceBear's adaptation](https://www.dicebear.com/styles/bottts-neutral/)
  of **Bottts** by [Pablo Stanley](https://bottts.com/), free for personal and
  commercial use under the [original artwork's license](https://bottts.com/).

Bottts Neutral avatars use each Agent's badge color as a solid background. Avatars are deterministically
assembled, resized, and clipped for display; native surfaces use locally
rasterized PNG copies.
