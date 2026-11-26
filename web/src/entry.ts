import { BrowserHost, BrowserRouter } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { App, appProps } from "./main.ts";
import { AppRoute } from "./route.ts";

/**
 * The demo is a production build, so the devtools overlay turns on for a
 * local page or a URL with `?devtools`. Anyone else never downloads it. The
 * overlay is optional, so a chunk that fails to load leaves the app without it.
 */
const isDevToolsOn =
	["localhost", "127.0.0.1"].includes(location.hostname) ||
	new URLSearchParams(location.search).has("devtools");

const devToolsLayer = isDevToolsOn
	? Layer.unwrap(
			Effect.tryPromise(() => import("@effect/ui-devtools")).pipe(
				Effect.map(({ DevTools }) =>
					DevTools.layer({ position: "BottomRight" }),
				),
				Effect.catch((error) =>
					Effect.logWarning("devtools failed to load", error).pipe(
						Effect.as(Layer.empty),
					),
				),
			),
		)
	: Layer.empty;

const Main = BrowserHost.mount(
	App,
	appProps,
	document.getElementById("root")!,
).pipe(
	Layer.provide([BrowserRouter.layer({ routes: AppRoute }), devToolsLayer]),
);

Layer.launch(Main).pipe(Effect.runFork);
