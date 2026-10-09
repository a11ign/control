Acceptance:

```bash
bash -c 'grep -q "CORE_REF: f3b5c5f595428bdfd970bd8ab6cf55edc770cf88" .github/workflows/ci.yml'
bash -c '! grep -n "code-version\.mjs" src/layer-checkouts.ts'
bash -c '! grep -n "rstest\.config\.mjs" .github/workflows/ci.yml'
```

Mutation: `ci.yml` with `--no-ignore` dropped, with `"exclude": []` dropped, and with the lay step before the install each fail their own assertion in `scripts/ci-composition.test.ts` and no other (8 tests, 1 file); restored with `cp`, `cmp` identical.
