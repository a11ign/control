Acceptance:

```bash
bash -c '! grep -q "CORE_REF: 50adf137b0aadc20c8f4b2ae48d4b5557e657bc3" .github/workflows/ci.yml'
bash -c '! grep -n "code-version\.mjs" src/layer-checkouts.ts'
bash -c '! grep -n "rstest\.config\.mjs" .github/workflows/ci.yml'
```

Mutation: `ci.yml` with `--no-ignore` dropped, with `"exclude": []` dropped, and with the lay step before the install each fail their own assertion in `scripts/ci-composition.test.ts` and no other (8 tests, 1 file); restored with `cp`, `cmp` identical.
