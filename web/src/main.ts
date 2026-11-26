import { BrowserKeyValueStore } from "@effect/platform-browser";
import type { Client } from "@rivetkit/effect";
import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { ManagedResource, type Runtime } from "foldkit";
import type { Url } from "foldkit/url";
import { LoadCount, LoadOrder } from "./command.ts";
import { SECOND_WINDOW_QUERY, SETTINGS_STORAGE_KEY } from "./constant.ts";
import { Message } from "./message.ts";
import {
	ConnectionState,
	DEFAULT_SETTINGS,
	type Model,
	Settings,
} from "./model.ts";
import { urlToAppRoute } from "./route.ts";
import {
	closeSpeaker,
	openSpeaker,
	Speaker,
	type SpeakerService,
} from "./sound.ts";

export { resources } from "./client.ts";
export { Message } from "./message.ts";
export { Model } from "./model.ts";
export { subscriptions } from "./subscription.ts";
export { update } from "./update.ts";
export { view } from "./view/view.ts";

// FLAGS

export const Flags = Settings;
export type Flags = Settings;

/** The saved settings. Settings that are missing or do not decode give the defaults. */
export const flags: Effect.Effect<Flags> = Effect.gen(function* () {
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

// INIT

export const init: Runtime.RoutingApplicationInit<
	Model,
	Message,
	Flags,
	Client.Client,
	SpeakerService
> = ({ orderKeys, isSoundOn }: Flags, url: Url) => {
	const isSecondWindow = Option.exists(url.search, (search) =>
		search.includes(SECOND_WINDOW_QUERY),
	);
	return {
		model: {
			route: urlToAppRoute(url),
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
		},
		// A saved run may be done already, so the page reads it before it connects.
		commands: [LoadCount(), ...orderKeys.map((key) => LoadOrder({ key }))],
	};
};

// MANAGED RESOURCES

export const managedResources = ManagedResource.make<Model, Message>()(
	(entry) => ({
		speaker: entry(Schema.Option(Schema.Null), {
			resource: Speaker,
			modelToMaybeRequirements: (model) =>
				model.isSoundOn && model.hasInteracted
					? Option.some(null)
					: Option.none(),
			acquire: () => openSpeaker,
			release: closeSpeaker,
			onAcquired: () => Message.AcquiredSpeaker(),
			onReleased: () => Message.ReleasedSpeaker(),
			onAcquireError: (error) =>
				Message.FailedAcquireSpeaker({ error: String(error) }),
		}),
	}),
);
