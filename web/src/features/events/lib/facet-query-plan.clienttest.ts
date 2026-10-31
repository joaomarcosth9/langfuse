// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { FilterState } from "@langfuse/shared";

import {
  planEventFacetQueries,
  resolveEventFacetColumnId,
  splitFacetFilter,
} from "@/src/features/events/lib/facet-query-plan";

const START_TIME: FilterState[number] = {
  column: "startTime",
  type: "datetime",
  operator: ">=",
  value: new Date("2026-01-01T00:00:00.000Z"),
};
const LEVEL_ERROR: FilterState[number] = {
  column: "level",
  type: "stringOptions",
  operator: "any of",
  value: ["ERROR"],
};
const ENV_PROD: FilterState[number] = {
  column: "environment",
  type: "stringOptions",
  operator: "any of",
  value: ["production"],
};
const SCORE_QUALITY: FilterState[number] = {
  column: "scores_avg",
  type: "numberObject",
  key: "quality",
  operator: ">",
  value: 0.5,
};
// Display-name keyed conditions: the search bar's lowering and the embed-scope
// filters (user/session detail pages) produce these instead of column ids.
const ENV_PROD_BY_LABEL: FilterState[number] = {
  column: "Environment",
  type: "stringOptions",
  operator: "any of",
  value: ["production"],
};
const USER_SCOPE_BY_LABEL: FilterState[number] = {
  column: "User ID",
  type: "string",
  operator: "=",
  value: "user-1",
};

const EAGER = ["environment", "level", "name", "scores_avg"] as const;

describe("splitFacetFilter", () => {
  it("routes start-time conditions (id and display name) into startTimeFilter", () => {
    const startTimeByLabel = { ...START_TIME, column: "Start Time" };
    expect(
      splitFacetFilter([START_TIME, startTimeByLabel, LEVEL_ERROR]),
    ).toEqual({
      startTimeFilter: [START_TIME, startTimeByLabel],
      refiningFilter: [LEVEL_ERROR],
    });
  });
});

describe("resolveEventFacetColumnId", () => {
  it("maps display names to column ids and passes ids/unknowns through", () => {
    expect(resolveEventFacetColumnId("Environment")).toBe("environment");
    expect(resolveEventFacetColumnId("User ID")).toBe("userId");
    expect(resolveEventFacetColumnId("environment")).toBe("environment");
    expect(resolveEventFacetColumnId("not-a-column")).toBe("not-a-column");
  });
});

describe("planEventFacetQueries", () => {
  it("keeps everything in one unrefined bulk when no filter is active", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [],
      eagerColumns: EAGER,
      lazyColumns: [],
    });
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.bulk.filter).toBeUndefined();
    expect(plan.perColumn).toEqual([]);
  });

  it("keeps a self-filtered facet in the bulk for server-side self-exclusion", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [LEVEL_ERROR],
      eagerColumns: EAGER,
      lazyColumns: [],
    });
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.bulk.filter).toEqual([LEVEL_ERROR]);
    expect(plan.perColumn).toEqual([]);
  });

  it("shares one bulk query across multiple self-filtered eager facets", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [ENV_PROD, LEVEL_ERROR],
      eagerColumns: EAGER,
      lazyColumns: [],
    });
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.bulk.filter).toEqual([ENV_PROD, LEVEL_ERROR]);
    expect(plan.perColumn).toEqual([]);
  });

  it("never evicts the score catalog from the bulk", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [SCORE_QUALITY],
      eagerColumns: EAGER,
      lazyColumns: [],
    });
    // The server ignores the filter for the catalog; the score condition still
    // refines the value facets sharing the bulk.
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.bulk.filter).toEqual([SCORE_QUALITY]);
    expect(plan.perColumn).toEqual([]);
  });

  it("passes display-name keyed conditions to the bulk unchanged", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [ENV_PROD_BY_LABEL],
      eagerColumns: EAGER,
      lazyColumns: [],
    });
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.bulk.filter).toEqual([ENV_PROD_BY_LABEL]);
    expect(plan.perColumn).toEqual([]);
  });

  it("refines every facet by an embed-scope condition without evicting the unrequested column", () => {
    // The user page scopes by `User ID` but omits the userId facet; the
    // condition refines all requested facets and evicts none of them.
    const plan = planEventFacetQueries({
      refiningFilter: [USER_SCOPE_BY_LABEL],
      eagerColumns: EAGER,
      lazyColumns: [],
    });
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.bulk.filter).toEqual([USER_SCOPE_BY_LABEL]);
    expect(plan.perColumn).toEqual([]);
  });

  it("keeps lazy columns separately cached and self-excludes their own conditions", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [USER_SCOPE_BY_LABEL, ENV_PROD],
      eagerColumns: EAGER,
      lazyColumns: ["version", "userId", "environment", "userId"],
    });
    expect(plan.bulk.columns).toEqual([...EAGER]);
    expect(plan.perColumn).toEqual([
      { column: "userId", filter: [ENV_PROD] },
      { column: "version", filter: [USER_SCOPE_BY_LABEL, ENV_PROD] },
    ]);
  });

  it("supports request-all mode with active filters", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [ENV_PROD],
      eagerColumns: undefined,
      lazyColumns: ["userId"],
    });
    expect(plan.bulk.columns).toBeUndefined();
    expect(plan.bulk.filter).toEqual([ENV_PROD]);
    expect(plan.perColumn).toEqual([]);
  });

  it("supports request-all mode (columns undefined) for unfiltered callers", () => {
    const plan = planEventFacetQueries({
      refiningFilter: [],
      eagerColumns: undefined,
      lazyColumns: [],
    });
    expect(plan.bulk.columns).toBeUndefined();
    expect(plan.bulk.filter).toBeUndefined();
    expect(plan.perColumn).toEqual([]);
  });
});
