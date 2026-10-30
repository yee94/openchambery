# Vendored Open Mascot core

Source: https://github.com/0oooh/open-mascot-studio

Pinned commit: `b83ca3863f4e35424342d42538873af1bacddf9f`
Package: `open-mascot` 0.1.0, MIT, Copyright 2026 0oooh.
See the adjacent unmodified `LICENSE`.

The six source/declaration files are byte-for-byte copies from
`packages/open-mascot/src` at that commit. No studio, web controller, assets,
third-party characters, or runtime dependencies are included. Yuri owns the
recipe/pigments, SVG serialization, live DOM adapter, visibility and animation
scheduling outside this directory. There are no runtime CDN/network imports.

SHA-256 (also verified by `recipe.test.ts`):

```text
45b3b68bab1e377ac2d97e8d2f0c56392aeaa3a1029e7cf6ce7f13293e04ab39 index.js
15b94552fa1c6c560d6a032017adbcfab9dd551468d4cae0174af0e42e9dcf2f index.d.ts
efeaf50d0ac83c83144c9bfef88c125c8d2e81d6cfa71be633fe556d47cbdc25 definition.js
e3e70b2ce2184c709576d5308c33b225a6a3f3ffc82c2701eea8fa9bab456e95 shapes.js
3f2a3b3b1b2129f95cf28fbf1026d20adc5c1cf0ee78537f916d3c28705d5f35 motion.js
7cb177ed0baecea1af6735ca2018f62dea0d639566a13f007eeeaa01446087e4 scene.js
```
