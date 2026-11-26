import { BrowserHost, BrowserRouter } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { App, appProps } from "./main.ts";
import { AppRoute } from "./route.ts";

const Main = BrowserHost.mount(
	App,
	appProps,
	document.getElementById("root")!,
).pipe(Layer.provide(BrowserRouter.layer({ routes: AppRoute })));

Layer.launch(Main).pipe(Effect.runFork);
