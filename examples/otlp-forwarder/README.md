# OTLP forwarder

One script that sends the agent events on your machine to an OpenTelemetry
collector, so they show up next to the rest of your telemetry. Node 20, no
dependencies, no Ascenda account. It's the sibling of the
[team forwarder](../team-forwarder/), which posts to an endpoint of your own
design. This one speaks OTLP/HTTP logs (JSON), so any collector, or any
backend that takes OTLP directly, can be the other end.

```bash
npx @ascenda-one/claude-code-hooks setup --no-pair
OTEL_RESOURCE_ATTRIBUTES=team.id=platform,department=eng \
  node examples/otlp-forwarder/forward-otlp.mjs --endpoint http://localhost:4318
```

It reads `~/.ascenda/events.jsonl` (see
[local-event-reader](../local-event-reader/)), sends one log record per event,
and keeps its place across restarts and log rotation. `--once` sends what's
there and exits.

The standard variables apply:

| Variable | Used for |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The base URL. `/v1/logs` is added. `--endpoint` does the same. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | The full logs URL, used as given. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers such as an API key, as `k=v,k=v`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Resource attributes on every record: `team.id`, `department`, anything you agree. |
| `OTEL_SERVICE_NAME` | `service.name`. Defaults to `ascenda-agent-events`. |

Which event field becomes which attribute is in the
[mapping table](../../packages/agent-events/README.md#mapping-to-opentelemetry).

Things to know:

- Only the public `event` is read. The collector's own `payload` beside it
  never leaves the machine.
- Delivery is at least once. A send that failed after the collector accepted
  it goes again, and OTLP has no dedupe, so drop repeats on
  `ascenda.event.id`.
- A `400` or `422` skips that batch. Anything else, including a `401`, keeps
  its place and retries, so a wrong key stalls the log instead of losing it.
- Read [Collecting from a team](../../docs/TEAM_COLLECTION.md) before this
  runs on other people's machines. The resource attributes are the part that
  says whose events these are.
