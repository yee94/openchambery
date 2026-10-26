# Handbook publication

The website and handbook are built from this repository and published together.
No separate documentation renderer repository is required.

## Website workflow

`.github/workflows/site.yml` validates changes to `site/`, `packages/docs/`, and
`scripts/docs/`. Pull requests build and check the static output. Main-branch
changes, published releases and manual dispatch use the website production job.

The deployment job pulls the existing website project's Vercel settings and runs
`vercel build --prod` **locally in the checked-out repository**. Its build command
reads both `site/` and `packages/docs/` and writes `site/dist/`. It deploys the
result with `vercel deploy --prebuilt --prod`; uploading only `site/` for a remote
source build would omit the handbook source and is not supported.

The same credentials and website project variables described in `site/README.md`
apply. Live verification compares all generated pages with this revision and
checks internal links, fragments and versioned resources.

## Source archives

`.github/workflows/docs-source.yml` remains a source archive job. It validates and
packages all retained MDX sources and attaches archives to release/manual tags as
before. It no longer dispatches builds to a separate website repository. Source
archives are not the deployed handbook and include the archived translations.

## Preview and rollback

Build and serve `site/dist/` using the commands in the package README. Previewing
does not publish. After deployment, rollback the website and handbook together to
a known-good deployment or repository revision; do not mix pages and assets from
different builds.
