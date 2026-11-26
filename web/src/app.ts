import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import { Message } from "./message.ts";
import { Model, Settings } from "./model.ts";
import { AppRoute } from "./route.ts";

/** What the page knows before it mounts: the route, the saved settings, and which window it is. */
export const AppProps = Schema.Struct({
	route: AppRoute,
	settings: Settings,
	isSecondWindow: Schema.Boolean,
});
export type AppProps = typeof AppProps.Type;

/** The root component's definition. `update` and `view` are typed against it. */
export const AppDef = Html.component({
	name: "App",
	props: AppProps,
	model: Model,
	message: Message,
});
