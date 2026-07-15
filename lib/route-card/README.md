# @mioagent/route-card

Deterministic read-only projection of a validated swap route evaluation. The package builds the
canonical T50 `RouteCardV1` only for honest `ready` or explicitly `constrained` recommendations,
and a UI-safe `RoutePlanProjectionV1` for every evaluation outcome.

It contains no LLM explanation, provider raw responses, HTTP state, transaction construction, or
execution controls.
