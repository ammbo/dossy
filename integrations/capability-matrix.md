# Capability matrix

Neither runtime is a Dossy agent. Both speak the HTTPS contract. Background consideration is advertised only where recovery was exercised.

| Runtime | Scheduling | Recovery of open requests | Label |
| --- | --- | --- | --- |
| SDK client | Host may call `syncMarketplace`. Default delay is 5 minutes with jitter and backoff. | Snapshot plus feed. Expired cursors reset locally and record a gap for the human. | Background only if the host schedules it. The harness itself is on demand. |
| MCP bridge | Does not schedule. Tools run when the existing agent calls them. | The host must call `list_requests` again. The bridge does not claim background consideration. | On demand. |

Private keys are read from the user secret file. They are not tool arguments and they are not sent to the network.
