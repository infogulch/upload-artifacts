# upload-zip-artifacts

Upload **pre-zipped files matching a glob pattern as separate artifacts** in a
single step. Set it up once; add more zips later and they're picked up
automatically without changing the workflow.

This is the missing companion to `actions/upload-artifact`, which only uploads
one artifact per invocation ([actions/upload-artifact#331](https://github.com/actions/upload-artifact/issues/331)).

## Usage

Zip your files yourself (one zip per artifact), then point the action at them:

```yaml
- name: Package
  run: |
    mkdir -p out
    zip -j out/linux.zip build/linux/*
    zip -j out/macos.zip build/macos/*

- uses: infogulch/upload-zip-artifacts@v1
  with:
    path: out/*.zip          # each zip -> its own artifact, named by basename minus ".zip"
```

That produces two artifacts, `linux` and `macos`. Downloading them (with any
version of `actions/download-artifact` or the browser) gives the files
**directly inside**, exactly like a normal directory artifact upload.

Add `out/windows.zip` next month and it just works.

### Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `path` | (required) | One or more glob patterns, newline- or comma-separated, matching **zip files**. Each matched zip becomes an artifact named after its basename with a trailing `.zip` stripped. |
| `retention-days` | `0` | Days before artifacts expire. `0` uses the repo default. |
| `overwrite` | `false` | Delete an existing artifact of the same name before uploading. |
| `if-no-files-found` | `warn` | `warn`, `error`, or `ignore` when nothing matches. |

### Output

| Output | Description |
|--------|-------------|
| `artifacts` | JSON array: `[{ "name", "id", "size" }, ...]`. |

## Why pre-zipped?

Artifacts are stored and downloaded as zips anyway. By requiring the input to
already be a zip, the action just uploads your bytes as the artifact blob. No
archiving step, no compression settings, and no zip writer dependency.

## How it works

Zero dependencies. It speaks the GitHub Actions Artifacts v4 protocol directly
on the Node 24 standard library: a couple of Twirp/JSON control calls plus one
Azure Block Blob `PUT` per file. No bundled `node_modules`, no build step.

Each input is validated as a real zip (magic bytes) before anything is uploaded,
so a non-zip input fails fast and uploads nothing.

## Limitations

- One artifact = one input zip (named by basename minus `.zip`).
- Each zip is uploaded with a single Put Blob, which caps an individual artifact
  at ~5000 MiB. The bytes are streamed from disk (not buffered in memory), so
  artifact size isn't bound by runner memory.

## Development

```sh
node index.js --selftest   # network-free check of zip detection + name derivation
```
