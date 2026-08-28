# Search helpers

`fuzzySearch.ts` owns generic substring/fuzzy scoring. `fileMentionSearch.ts` owns `@` mention path ranking: query intent (`.ext` → files, `foo/` → directories), source-over-test, and dropping unmatched candidates. Chat autocomplete merges server hits then calls `rankFileMentionSearch`.
