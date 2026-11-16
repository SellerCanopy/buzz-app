import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  ALL,
  NO_WORKFLOW,
  STATE_FILTERS,
  passes,
  repoOf,
  type Filters,
} from "./boardModel";
import type { Card } from "./gen/kiln/engine/v1/engine_pb";

type Option = { value: string; name: string; count: number };

/** One group of filter tabs: All, then each option that has cards or is the one chosen. */
function FilterTabs({
  label,
  value,
  total,
  options,
  onChange,
}: {
  label: string;
  value: string;
  total: number;
  options: Option[];
  onChange(value: string): void;
}) {
  const shown = options.filter(
    (option) => option.count > 0 || option.value === value,
  );
  // A group with nothing to choose between is left out.
  if (shown.length === 0 && value === ALL) return null;
  return (
    <Tabs
      variant="segmented"
      size="sm"
      label={label}
      value={value}
      items={[
        { value: ALL, label: `All ${total}` },
        ...shown.map((option) => ({
          value: option.value,
          label: `${option.name} ${option.count}`,
        })),
      ]}
      onValueChange={onChange}
    />
  );
}

/**
 * The search field and the State, Repo, Workflow and Archive filters of the board. Each group
 * counts the cards that pass the other filters, so a count says what choosing it would show.
 */
export function BoardFilters({
  cards,
  archivedCount,
  archived,
  filters,
  onFilters,
  onArchived,
}: {
  /** The cards of the list being shown, the board or the archive. */
  cards: Card[];
  archivedCount: number;
  archived: boolean;
  filters: Filters;
  onFilters(next: Filters): void;
  onArchived(archived: boolean): void;
}) {
  const count = (skip: keyof Filters, test: (card: Card) => boolean) =>
    cards.filter((card) => passes(card, filters, skip) && test(card)).length;
  const total = (skip: keyof Filters) => count(skip, () => true);
  const set = (field: keyof Filters) => (value: string) =>
    onFilters({ ...filters, [field]: value });

  const repos = [...new Set(cards.map(repoOf).filter(Boolean))].sort();
  const workflows = [
    ...new Set(cards.map((card) => card.workflow).filter(Boolean)),
  ].sort();

  return (
    <div className="beehive-filters">
      <div className="beehive-search-field">
        <SearchField
          label="Search cards"
          placeholder="Search by title or #number"
          value={filters.text}
          onValueChange={set("text")}
        />
      </div>
      {cards.length > 0 && (
        <>
          <FilterTabs
            label="State"
            value={filters.state}
            total={total("state")}
            options={STATE_FILTERS.map((state) => ({
              value: state.value,
              name: state.label,
              count: count("state", (card) => card.state === state.value),
            }))}
            onChange={set("state")}
          />
          <FilterTabs
            label="Repo"
            value={filters.repo}
            total={total("repo")}
            options={repos.map((repo) => ({
              value: repo,
              name: repo,
              count: count("repo", (card) => repoOf(card) === repo),
            }))}
            onChange={set("repo")}
          />
          <FilterTabs
            label="Workflow"
            value={filters.workflow}
            total={total("workflow")}
            options={[
              ...workflows.map((workflow) => ({
                value: workflow,
                name: workflow,
                count: count("workflow", (card) => card.workflow === workflow),
              })),
              {
                value: NO_WORKFLOW,
                name: "No workflow",
                count: count("workflow", (card) => !card.workflow),
              },
            ]}
            onChange={set("workflow")}
          />
        </>
      )}
      <Tabs
        variant="segmented"
        size="sm"
        label="Archive"
        value={archived ? "archived" : null}
        items={[{ value: "archived", label: `Archived ${archivedCount}` }]}
        onValueChange={() => onArchived(true)}
        onReselect={() => onArchived(false)}
      />
    </div>
  );
}
