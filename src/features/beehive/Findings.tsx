import type { Finding } from "./gen/kiln/engine/v1/engine_pb";

const SEVERITIES: Record<string, { label: string; tone: string }> = {
  error: { label: "Error", tone: "text-danger" },
  warning: { label: "Warning", tone: "text-warning" },
  note: { label: "Note", tone: "text-subtle" },
};

/**
 * What the workflow checks found, each with its severity, its code, what is wrong and where.
 * `scope` names the part of the workflow a finding is about, such as a stage, when the list
 * mixes several.
 */
export function Findings({
  label,
  findings,
  scope,
}: {
  label: string;
  findings: Finding[];
  scope?: (finding: Finding) => string | undefined;
}) {
  if (!findings.length) return null;
  return (
    <ul className="beehive-findings" aria-label={`Findings for ${label}`}>
      {findings.map((finding) => {
        const severity = SEVERITIES[finding.severity] ?? {
          label: finding.severity,
          tone: "text-subtle",
        };
        const where = scope?.(finding);
        return (
          <li key={`${finding.path}|${finding.code}|${finding.message}`}>
            {where && <span className="text-label">{`${where} `}</span>}
            <span className={`text-body-sm ${severity.tone}`}>
              {severity.label}
            </span>{" "}
            <code className="text-mono-sm">{finding.code}</code>{" "}
            {finding.message}
            {finding.path && (
              <span className="text-body-sm text-subtle"> {finding.path}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
