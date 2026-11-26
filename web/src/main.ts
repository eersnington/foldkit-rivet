import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Component, Head, Router } from "@effect/ui";
import { Effect, Layer, Option } from "effect";
import { KeyValueStore } from "effect/persistence";
import { AppDef, type AppProps } from "./app.ts";
import { clientLayer } from "./client.ts";
import {
	Increment,
	LoadCount,
	LoadOrder,
	PlayCue,
	SaveSettings,
	StopActor,
} from "./command.ts";
import { SECOND_WINDOW_QUERY, SETTINGS_STORAGE_KEY, TITLE } from "./constant.ts";
import { ConnectionState, DEFAULT_SETTINGS, Settings } from "./model.ts";
import { AppRoute } from "./route.ts";
import { Speaker } from "./sound.ts";
import { subscriptions } from "./subscription.ts";
import { update } from "./update.ts";
import { view } from "./view/view.ts";

// PROPS

/** The saved settings. Settings that are missing or do not decode give the defaults. */
const savedSettings: Effect.Effect<Settings> = Effect.gen(function* () {
	const store = KeyValueStore.toSchemaStore(
		yield* KeyValueStore.KeyValueStore,
		Settings,
	);
	const maybeSettings = yield* store.get(SETTINGS_STORAGE_KEY);
	return Option.getOrElse(maybeSettings, () => DEFAULT_SETTINGS);
}).pipe(
	Effect.catch(() => Effect.succeed(DEFAULT_SETTINGS)),
	Effect.provide(BrowserKeyValueStore.layerLocalStorage),
);

/** The root's props, read once when it mounts. */
export const appProps: Effect.Effect<AppProps, never, Router.Router> =
	Effect.all({
		route: Router.currentRoute(AppRoute),
		settings: savedSettings,
		isSecondWindow: Effect.sync(() =>
			location.search.includes(SECOND_WINDOW_QUERY),
		),
	});

// APP

const AppNoDeps = AppDef.make({
	init: ($) => {
		const { route, settings, isSecondWindow } = $.props;
		const { orderKeys, isSoundOn } = settings;
		return $.set({
			route,
			connection: ConnectionState.Connecting(),
			maybeError: Option.none(),
			isSoundOn: isSoundOn && !isSecondWindow,
			isSecondWindow,
			hasInteracted: false,
			isReloading: false,
			orders: orderKeys.map((key) => ({
				key,
				steps: [],
				latestFrom: "read",
				sleptMs: 0,
				isRestored: true,
				isKnown: false,
				maybeJoinedAtMs: Option.none(),
				wokeAt: [],
				isDisconnected: false,
				maybeStop: Option.none(),
			})),
			counter: {
				maybeCount: Option.none(),
				pendingIncrements: 0,
				presses: 0,
				bursts: 0,
				maybeBurst: Option.none(),
				recentCalls: [],
				maybeLastChange: Option.none(),
			},
			feed: [],
			// A saved run may be done already, so the page reads it before it connects.
		}).run(LoadCount.make(), ...orderKeys.map((key) => LoadOrder.make({ key })));
	},
	update,
	subscriptions,
	head: () => [Head.title(TITLE)],
	view,
});

/** One speaker and one Rivet client for the whole page. */
const appLayer = Layer.mergeAll(
	PlayCue.layer,
	SaveSettings.layer.pipe(
		Layer.provide(BrowserKeyValueStore.layerLocalStorage),
	),
	LoadCount.layer,
	Increment.layer,
	LoadOrder.layer,
	StopActor.layer,
).pipe(Layer.provideMerge(Layer.merge(Speaker.layer, clientLayer)));

export const App = AppNoDeps.pipe(Component.provide(appLayer));
