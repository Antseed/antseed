# Local Whisper resources

Antseed Desktop's local voice transcription expects:

```txt
resources/whisper/
  models/ggml-tiny.bin
  bin/<platform>-<arch>/whisper-cli[.exe]
```

Examples:

```txt
bin/darwin-arm64/whisper-cli
bin/darwin-x64/whisper-cli
bin/win32-x64/whisper-cli.exe
bin/linux-x64/whisper-cli
models/ggml-tiny.bin
```

Use the multilingual `ggml-tiny.bin` model from whisper.cpp. Optional better models are downloaded into the user's app data directory from Settings; Base multilingual uses `ggml-base.bin`.

These large/native artifacts are intentionally not committed by this scaffold.
