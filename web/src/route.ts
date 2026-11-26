import { pipe, Schema } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal } from "foldkit/route";

/** One route for each demo. */
export const AppRoute = defineRouteUnion({
	Order: {},
	Counter: {},
	NotFound: { path: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

export const orderRouter = pipe(Route.root, Route.mapTo(AppRoute.Order));

export const counterRouter = pipe(
	literal("counter"),
	Route.mapTo(AppRoute.Counter),
);

export const urlToAppRoute = Route.parseUrlWithFallback(
	Route.oneOf(counterRouter, orderRouter),
	AppRoute.NotFound,
);
