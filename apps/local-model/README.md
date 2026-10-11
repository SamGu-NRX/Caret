# caret-local-model

Answers grammar-constrained completions from a local GGUF, for the helper's local intent maker
(`helper/src/planner/intent-local.ts`). It loads the model once and reads it in place by path: llama maps the
file, nothing is copied. The development model is Cotypist's Gemma file, so treat it as read-only.

## Build

The llama build is KeyType's, gitignored here. Copy it from a checkout that has KeyType's submodule:

```sh
cp -R "../../../caret-v2-host/packages/keytype/Packages/ModelRuntime/Vendor/llama.xcframework" Vendor/
swift build -c release   # under the shared heavy lock on the dev Mac
```

`swift test` reads only the model's vocabulary. Its grammar tests run when the GGUF is at `CARET_MODEL_PATH`
or Cotypist's path, and are skipped otherwise.

## Protocol

`caret-local-model --model PATH [--ctx 4096]` writes one line first: `{"ready":true,"model","loadMs","nCtx","memory"}`,
or `{"ready":false,"error"}` and exit status 2.

Each stdin line is one request, answered by one stdout line, in order:

```json
{"id":"a1","prefix":"few-shot block","prompt":"this request","grammar":"root ::= ...","maxTokens":160}
```

- `prefix` is optional. Its decoded state is kept, and a later request with the same prefix restores it instead
  of decoding it again.
- Decoding is greedy over the tokens the grammar allows. The output can only be text in the grammar's language,
  and ends when the model ends it or `maxTokens` runs out (`stop` says which).
- The answer is `{"id","ok":true,"text","stop","prefixTokens","prefixCached","promptTokens","outputTokens","ms","memory"}`,
  or `{"id","ok":false,"error"}`. The id is null when the line was not a request.
- `memory` is the process's own: resident and footprint MB now, and their peaks.

End of input exits 0.
