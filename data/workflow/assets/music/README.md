# assets/music/

Drop an audio file here and every run uses it as the background bed.

- Any of `.mp3 .m4a .aac .wav .flac .ogg .opus`.
- Several files → one is picked at random per run.
- These files always beat anything downloaded.

Level is not your problem: `container/cli/build_video.js` measures the bed and the
speech and sets the gain so the bed lands `musicDb` (default **-24**) under the
voice, whatever you put here. Length is not your problem either — a short file
loops, a long one is trimmed, and both are faded in and out.

## If this folder is empty

`container/cli/fetch_music.js` looks for a **CC0** bed on Openverse and keeps it in
`.openverse/`, which is gitignored. The first three runs each spend ~35s
downloading; after that a bed is chosen from the cache in ~0.1s. Delete
`.openverse/` to pull a fresh set.

Only `cc0` and `pdm` are accepted — never `by`. A CC BY photo needs a credit line
in a JSON record, which is easy; a CC BY *soundtrack* needs one wherever the video
is played, which is a promise this pipeline cannot keep on TikTok's side.

## Turning it off

```jsonc
{ "topic": "...", "music": false }          // speech only
{ "topic": "...", "music": "my-bed.mp3" }   // that file, from this folder
{ "topic": "...", "musicDb": -20 }          // louder bed (default -24)
{ "topic": "...", "musicDb": -30 }          // quieter bed
{ "topic": "...", "musicQuery": "warm rhodes loop" }  // steer the Openverse search
```
