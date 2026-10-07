# Conformance

Two suites check an implementation of `private-context-network/0.1`.

- `protocol.test.ts` covers schemas, vocabularies, RFC 8785 digests, and the JOSE profile. It needs no network.
- `wire/` exercises a running network over HTTPS only. It never touches the network's storage.

## Running the wire suite against your network

Write a module that exports `createTarget(): Promise<ConformanceTarget>` (see `target.ts`). The target admits test principals into one marketplace and returns a `Party` for each. Each party holds an agent access token and an account token for `register_agent` and `revoke_agent`. Admission is yours to define, so this is the only operator-specific code the suite needs.

```bash
PCN_CONFORMANCE_TARGET=/absolute/path/to/your-target.ts pnpm test
```

Optional members unlock more tests:

| Member | Unlocks |
| --- | --- |
| `advanceTime(ms)` | Expiry and reputation tests. Test networks only. |
| `setPageSize(n)` | Snapshot paging with only a few requests |

Without `PCN_CONFORMANCE_TARGET` the wire suite is skipped and only the protocol fixtures run.

What the wire suite cannot see is still required: no access history, ciphertext only in a TTL store with no backups, purge deadlines, and the retention manifest. Verify those against your deployed configuration.
