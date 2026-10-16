# Validation

- Formal-policy fixed-input replay: exit 0; 42/42 successes; Old Success -> V2 Fail 0; Old Fail -> V2 Success 2; A/B/MVA 6/21/15; selected known overlap/duplicate conflicts 0; 5/5 technical blocks classified UPSTREAM_BLOCKED.
- Final relevant Node suite: 93 passed, 0 failed (formal policy, audit, historical V2, legacy scheduler, ShotPool, semantic schema, product visual review, renderer dry-run/conversion and service render gate).
- TypeScript `--noEmit --incremental false`: exit 0.
- ESLint targeted code: no errors. Worker processor retains two pre-existing unused-symbol warnings (readFile and scanOutputs).
- No Provider calls, MP4 renders, feature-flag writes, Batch pins, worker restarts or production artifact writes during replay.
- Frozen input and protected config/Gate/renderer hashes verified unchanged. The accepted historical Shadow implementation remains separately reproducible.
- This is Shadow/code verification. Existing sampled-frame review supports three selected same-source pairs; complete video perceptual near-duplicate or encoded-duration acceptance was not performed.
