import { Route } from "@effect/ui";

/** One route for each demo. `/*` catches every other path. */
export const AppRoute = Route.union({
	Order: Route.make("/"),
	Counter: Route.make("/counter"),
	NotFound: Route.make("/*"),
});
export type AppRoute = typeof AppRoute.Type;

export const orderPath = AppRoute.print(AppRoute.Order());

export const counterPath = AppRoute.print(AppRoute.Counter());
