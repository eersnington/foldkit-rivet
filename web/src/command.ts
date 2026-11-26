import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Clock, Duration, Effect, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";
import { counter, order } from "./client.ts";
import {
	POWER_OFF_MS,
	SECOND_WINDOW_QUERY,
	SETTINGS_STORAGE_KEY,
} from "./constant.ts";
import { Message } from "./message.ts";
import { FeedEvent, Settings } from "./model.ts";
import { counterRouter } from "./route.ts";
import { Cue, playCue, Speaker } from "./sound.ts";

// PAGE

export const NavigateInternal = Command.define("NavigateInternal", {
	args: { url: Schema.String },
	messages: [Message.CompletedNavigateInternal],
	execute: ({ url }) =>
		pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

export const LoadExternal = Command.define("LoadExternal", {
	args: { href: Schema.String },
	messages: [Message.CompletedLoadExternal],
	execute: ({ href }) =>
		load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

/** The settings survive a reload. A failed save loses nothing the page needs now. */
export const SaveSettings = Command.define("SaveSettings", {
	args: { settings: Settings },
	messages: [Message.CompletedSaveSettings],
	execute: ({ settings }) =>
		Effect.gen(function* () {
			const store = KeyValueStore.toSchemaStore(
				yield* KeyValueStore.KeyValueStore,
				Settings,
			);
			yield* store.set(SETTINGS_STORAGE_KEY, settings);
		}).pipe(
			Effect.ignore,
			Effect.provide(BrowserKeyValueStore.layerLocalStorage),
			Effect.as(Message.CompletedSaveSettings()),
		),
});

/** Plays a cue while the speaker is open, and does nothing while it is closed. */
export const PlayCue = Command.define("PlayCue", {
	args: { cue: Cue },
	messages: [Message.CompletedPlayCue],
	execute: ({ cue }) =>
		Speaker.get.pipe(
			Effect.flatMap((speaker) => playCue(speaker, cue)),
			Effect.catchTag("ResourceNotAvailable", () => Effect.void),
			Effect.as(Message.CompletedPlayCue()),
		),
});

/** Stamps an event with the time it arrived, so `update` stays pure. */
export const TimestampFeedEvent = Command.define("TimestampFeedEvent", {
	args: {
		name: FeedEvent.fields.name,
		text: Schema.String,
		source: Schema.String,
	},
	messages: [Message.TimestampedFeedEvent],
	execute: ({ name, text, source }) =>
		Clock.currentTimeMillis.pipe(
			Effect.map((at) =>
				Message.TimestampedFeedEvent({ event: { at, name, text, source } }),
			),
		),
});

// COUNTER

export const LoadCount = Command.define("LoadCount", {
	messages: [Message.SucceededLoadCount, Message.FailedLoadCount],
	execute: counter.pipe(
		Effect.flatMap((handle) => handle.GetCount()),
		Effect.map((count) => Message.SucceededLoadCount({ count })),
		Effect.catch((error) =>
			Effect.succeed(Message.FailedLoadCount({ error: error.message })),
		),
	),
});

/** Calls `Increment` and measures the round trip. A burst sends many of these at once. */
export const Increment = Command.define("Increment", {
	args: { maybeBurstId: Schema.Option(Schema.Number) },
	messages: [Message.SucceededIncrement, Message.FailedIncrement],
	execute: ({ maybeBurstId }) =>
		counter.pipe(
			Effect.flatMap((handle) => Effect.timed(handle.Increment({ amount: 1 }))),
			Effect.map(([took, count]) =>
				Message.SucceededIncrement({
					count,
					tookMs: Math.round(Duration.toMillis(took)),
					maybeBurstId,
				}),
			),
			Effect.catch((error) =>
				Effect.succeed(Message.FailedIncrement({ error: error.message })),
			),
		),
});

/** A small window beside this one, so two clients of the counter are on screen at once. */
export const OpenClient = Command.define("OpenClient", {
	messages: [Message.CompletedOpenClient],
	execute: Effect.sync(() => {
		window.open(
			`${counterRouter()}?${SECOND_WINDOW_QUERY}`,
			"_blank",
			"popup,width=460,height=760",
		);
		return Message.CompletedOpenClient();
	}),
});

// ORDER

const KEY_ADJECTIVES = [
	"brave",
	"sleepy",
	"shiny",
	"sturdy",
	"tiny",
	"loud",
	"calm",
	"lucky",
];
const KEY_NOUNS = [
	"anvil",
	"bolt",
	"crate",
	"gear",
	"parcel",
	"rivet",
	"spring",
	"washer",
];

const pick = (words: ReadonlyArray<string>) =>
	words[Math.floor(Math.random() * words.length)];

/** A readable key such as `sleepy-anvil-3f2a`. The hex part keeps it unique. */
export const GenerateOrderKey = Command.define("GenerateOrderKey", {
	messages: [Message.GeneratedOrderKey],
	execute: Effect.sync(() =>
		Message.GeneratedOrderKey({
			key: `${pick(KEY_ADJECTIVES)}-${pick(KEY_NOUNS)}-${crypto.randomUUID().slice(0, 4)}`,
		}),
	),
});

export const LoadOrder = Command.define("LoadOrder", {
	args: { key: Schema.String },
	messages: [Message.SucceededLoadOrder, Message.FailedLoadOrder],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const handle = yield* order(key);
			const { steps, wokeAt } = yield* handle.GetStatus();
			const loadedAt = yield* Clock.currentTimeMillis;
			return Message.SucceededLoadOrder({ key, steps, wokeAt, loadedAt });
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(Message.FailedLoadOrder({ error: error.message })),
			),
		),
});

/** Stops the order's actor, and notes when, so the page can mark the moment on the timeline. */
export const StopActor = Command.define("StopActor", {
	args: { key: Schema.String },
	messages: [Message.SucceededStopActor, Message.FailedStopActor],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const handle = yield* order(key);
			yield* handle.Stop();
			const stoppedAt = yield* Clock.currentTimeMillis;
			return Message.SucceededStopActor({ key, stoppedAt });
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(Message.FailedStopActor({ error: error.message })),
			),
		),
});

/** Waits until the stopped actor's sleep is over, so the page connects again only after it. */
export const WaitForSleepEnd = Command.define("WaitForSleepEnd", {
	args: {
		key: Schema.String,
		wakesBefore: Schema.Number,
		delayMs: Schema.Number,
	},
	messages: [Message.CompletedWaitForSleepEnd],
	execute: ({ key, wakesBefore, delayMs }) =>
		Effect.sleep(Duration.millis(delayMs)).pipe(
			Effect.as(Message.CompletedWaitForSleepEnd({ key, wakesBefore })),
		),
});

/** Reloads the page after the screen has switched off. */
export const ReloadPage = Command.define("ReloadPage", {
	messages: [Message.CompletedReloadPage],
	execute: Effect.sleep(Duration.millis(POWER_OFF_MS)).pipe(
		Effect.andThen(Effect.sync(() => location.reload())),
		Effect.as(Message.CompletedReloadPage()),
	),
});
