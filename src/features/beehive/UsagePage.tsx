import { useEffect, useState } from "react";
import { ChartBarIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { GetUsageResponse } from "./gen/kiln/engine/v1/engine_pb";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; usage: GetUsageResponse }
  | { status: "error"; message: string };

/** `75` as `1m 15s`, `3700` as `1h 1m`. */
export function formatDuration(seconds: bigint | number): string {
  const total = Number(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The Monday a week starts on, as `Nov 3`. The engine sends a calendar date, not a moment. */
function weekLabel(starts: string): string {
  const date = new Date(`${starts}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? starts
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

/**
 * What the agents did: how many runs there were and how long they took, and for each of the
 * last weeks how many cards agents created and how many runs they started. Only counts and
 * durations: Beehive keeps no token or cost figures.
 */
export function UsagePage({ client }: { client: Client }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `attempt` re-reads after a failure.
    void attempt;
    const abort = new AbortController();
    setLoaded({ status: "loading" });
    client
      .getUsage(abort.signal)
      .then((usage) => {
        if (!abort.signal.aborted) setLoaded({ status: "ready", usage });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  const usage = loaded.status === "ready" ? loaded.usage : undefined;
  const quiet =
    usage &&
    usage.runs === 0 &&
    usage.weeks.every(
      (week) => week.cardsCreatedByAgents + week.runsStartedByAgents === 0,
    );
  return (
    <LoadingRegion
      pending={loaded.status === "loading"}
      label="Loading usage…"
      feedback={
        loaded.status === "error" ? (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {loaded.message}
            </p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : undefined
      }
    >
      {quiet && (
        <EmptyState
          icon={<ChartBarIcon size="1.5rem" />}
          title="No activity yet"
          description="Runs and what agents start show up here."
        />
      )}
      {usage && !quiet && <Figures usage={usage} />}
    </LoadingRegion>
  );
}

function Figures({ usage }: { usage: GetUsageResponse }) {
  const peak = Math.max(
    1,
    ...usage.weeks.flatMap((week) => [
      week.cardsCreatedByAgents,
      week.runsStartedByAgents,
    ]),
  );
  const timed = usage.endedRuns > 0;
  return (
    <div className="beehive-usage">
      <section aria-label="Runs">
        <InlineHeader title="Runs" />
        <dl className="beehive-figures">
          <Figure label="Runs" value={String(usage.runs)} />
          <Figure label="Ended" value={String(usage.endedRuns)} />
          <Figure
            label="Average run"
            value={timed ? formatDuration(usage.averageRunSeconds) : "None yet"}
          />
          <Figure
            label="Longest run"
            value={timed ? formatDuration(usage.longestRunSeconds) : "None yet"}
          />
        </dl>
      </section>
      <section aria-label="Started by agents, by week">
        <InlineHeader
          title="Started by agents"
          subtitle="Cards agents created and runs agents started, for each week."
        />
        <ul className="beehive-legend text-body-sm">
          <li>
            <span className="beehive-swatch" data-series="1" aria-hidden />
            Cards created
          </li>
          <li>
            <span className="beehive-swatch" data-series="2" aria-hidden />
            Runs started
          </li>
        </ul>
        <table className="beehive-weeks">
          <caption className="sr-only">
            Cards created and runs started by agents, for each week
          </caption>
          <thead>
            <tr>
              <th scope="col" className="text-label text-subtle">
                Week of
              </th>
              <th scope="col" className="text-label text-subtle">
                Cards created
              </th>
              <th scope="col" className="text-label text-subtle">
                Runs started
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.weeks.map((week) => (
              <tr key={week.starts}>
                <th scope="row" className="text-body-sm">
                  {weekLabel(week.starts)}
                </th>
                <td>
                  <Bar
                    series={1}
                    value={week.cardsCreatedByAgents}
                    peak={peak}
                  />
                </td>
                <td>
                  <Bar
                    series={2}
                    value={week.runsStartedByAgents}
                    peak={peak}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-label text-subtle">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** A count with a bar the width of its share of the busiest week. */
function Bar({
  series,
  value,
  peak,
}: {
  series: 1 | 2;
  value: number;
  peak: number;
}) {
  return (
    <span className="beehive-bar">
      <span
        className="beehive-bar-mark"
        data-series={series}
        style={{ inlineSize: `${(value / peak) * 100}%` }}
        aria-hidden
      />
      <span className="text-body-sm">{value}</span>
    </span>
  );
}
