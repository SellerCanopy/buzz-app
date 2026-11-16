import type { ReactNode } from "react";

/**
 * A note that a card waits on a person, with the buttons that answer it. The design system has
 * no callout, so this is Beehive's own, drawn like the board's notice.
 */
export function Callout({
  tone,
  title,
  children,
  actions,
}: {
  tone: "warning" | "danger";
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="beehive-callout" data-tone={tone} aria-label={title}>
      <div>
        <p className="text-label">{title}</p>
        <p className="text-body-sm text-subtle">{children}</p>
      </div>
      {actions && <div className="beehive-callout-actions">{actions}</div>}
    </section>
  );
}
