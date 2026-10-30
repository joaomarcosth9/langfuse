import {
  eventsTableCols,
  type FilterState,
  type TimeFilter,
} from "@langfuse/shared";

// Eager facets share a bulk request with server-side self-exclusion. Lazy
// facets retain individual requests and cache entries.

// Filters can be keyed by column id ("environment") or display name ("User ID",
// as the embed-scope filters are). Facet columns are always ids — a label that
// slipped past self-exclusion would self-collapse its facet.
const FACET_COLUMN_ID_BY_NAME_OR_ID: ReadonlyMap<string, string> = new Map(
  eventsTableCols.flatMap((c) => [
    [c.id, c.id],
    [c.name, c.id],
  ]),
);

export const resolveEventFacetColumnId = (column: string): string =>
  FACET_COLUMN_ID_BY_NAME_OR_ID.get(column) ?? column;

const isStartTimeCondition = (f: FilterState[number]): f is TimeFilter =>
  f.type === "datetime" &&
  (f.column === "startTime" || f.column === "Start Time");

/**
 * Split user-authored start-time conditions (e.g. a search-bar `startTime:>…`)
 * from the refining rest. They must travel via the authoritative
 * `startTimeFilter` channel — the server drops start-time entries from the
 * participating filter, so leaving them here would silently un-scope the counts.
 * Non-participating columns (input/output/comment*, positionInTrace) pass
 * through verbatim; the server omits all counts while one is active.
 */
export const splitFacetFilter = (
  filter: FilterState,
): { startTimeFilter: TimeFilter[]; refiningFilter: FilterState } => ({
  startTimeFilter: filter.filter(isStartTimeCondition),
  refiningFilter: filter.filter((f) => !isStartTimeCondition(f)),
});

export type FacetQueryPlan<Column extends string = string> = {
  /** Shared bulk query: the server self-excludes each requested facet's own
   *  conditions. `columns` undefined requests every supported facet. */
  bulk: {
    columns: Column[] | undefined;
    filter: FilterState | undefined;
  };
  /** One self-excluded query per lazily-requested column, with its own cache
   *  entry and no duplicate request for a column already in the bulk. */
  perColumn: { column: Column; filter: FilterState | undefined }[];
};

/**
 * Share eager columns in one bulk request and keep lazy columns independently
 * cached. `refiningFilter` must be start-time-free (see `splitFacetFilter`).
 */
export function planEventFacetQueries<Column extends string>(params: {
  refiningFilter: FilterState;
  eagerColumns: readonly Column[] | undefined;
  lazyColumns: readonly Column[];
}): FacetQueryPlan<Column> {
  const { refiningFilter, eagerColumns, lazyColumns } = params;

  const filterFor = (column: Column): FilterState | undefined => {
    const refined = refiningFilter.filter(
      (f) => resolveEventFacetColumnId(f.column) !== column,
    );
    return refined.length > 0 ? refined : undefined;
  };

  const eagerColumnSet = new Set(eagerColumns);
  const perColumn = Array.from(new Set(lazyColumns))
    .filter(
      (column) => eagerColumns !== undefined && !eagerColumnSet.has(column),
    )
    .sort()
    .map((column) => ({ column, filter: filterFor(column) }));

  return {
    bulk: {
      columns: eagerColumns ? [...eagerColumns] : undefined,
      filter: refiningFilter.length > 0 ? refiningFilter : undefined,
    },
    perColumn,
  };
}
