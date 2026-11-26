import { Command, Component } from "@effect/ui";
import { Clock, Duration, Effect, Option, Ref, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { counter, order } from "./client.ts";
import {
	POWER_OFF_MS,
	SECOND_WINDOW_QUERY,
	SETTINGS_STORAGE_KEY,
} from "./constant.ts";
import { Message } from "./message.ts";
import { FeedEvent, Settings } from "./model.ts";
import { counterPath } from "./route.ts";
import { Cue, playCue, Speaker } from "./sound.ts";

// PAGE

/** The settings survive a reload. A failed save loses nothing the page needs now. */
export class SaveSettings extends Command.Service<SaveSettings>()(
	"page/SaveSettings",
	{ args: { settings: Settings }, success: Component.Noop },
) {
	static readonly layer = this.toLayer(
		Effect.gen(function* () {
			const store = KeyValueStore.toSchemaStore(
				yield* KeyValueStore.KeyValueStore,
				Settings,
			);
			return ({ settings }) =>
				store
					.set(SETTINGS_STORAGE_KEY, settings)
					.pipe(Effect.ignore, Effect.as(Component.noop));
		}),
	);
}

/** Plays a cue while the speaker is open, and does nothing while it is closed. */
export class PlayCue extends Command.Service<PlayCue>()("page/PlayCue", {
	args: { cue: Cue },
	success: Component.Noop,
}) {
	static readonly layer = this.toLayer(
		Effect.gen(function* () {
			const { current } = yield* Speaker;
			return ({ cue }) =>
				Ref.get(current).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.void,
							onSome: (speaker) => playCue(speaker, cue),
						}),
					),
					Effect.as(Component.noop),
				);
		}),
	);
}

/** Stamps an event with the time it arrived, so `update` stays pure. */
export const TimestampFeedEvent = Command.make(
	"TimestampFeedEvent",
	{
		args: {
			name: FeedEvent.fields.name,
			text: Schema.String,
			source: Schema.String,
		},
	},
	({ name, text, source }) =>
		Clock.currentTimeMillis.pipe(
			Effect.map((at) =>
				Message.TimestampedFeedEvent({ event: { at, name, text, source } }),
			),
		),
);

// COUNTER

export class LoadCount extends Command.Service<LoadCount>()(
	"counter/LoadCount",
	{ args: {}, success: Message },
) {
	static readonly layer = this.toLayer(
		Effect.gen(function* () {
			const handle = yield* counter;
			return () =>
				handle.GetCount().pipe(
					Effect.match({
						onSuccess: (count) => Message.SucceededLoadCount({ count }),
						onFailure: (error) =>
							Message.FailedLoadCount({ error: error.message }),
					}),
				);
		}),
	);
}

/** Calls `Increment` and measures the round trip. A burst sends many of these at once. */
export class Increment extends Command.Service<Increment>()(
	"counter/Increment",
	{ args: { maybeBurstId: Schema.Option(Schema.Number) }, success: Message },
) {
	static readonly layer = this.toLayer(
		Effect.gen(function* () {
			const handle = yield* counter;
			return ({ maybeBurstId }) =>
				Effect.timed(handle.Increment({ amount: 1 })).pipe(
					Effect.match({
						onSuccess: ([took, count]) =>
							Message.SucceededIncrement({
								count,
								tookMs: Math.round(Duration.toMillis(took)),
								maybeBurstId,
							}),
						onFailure: (error) =>
							Message.FailedIncrement({ error: error.message }),
					}),
				);
		}),
	);
}

/** A small window beside this one, so two clients of the counter are on screen at once. */
export const OpenClient = Command.make("OpenClient", { args: {} }, () =>
	Effect.sync(() => {
		window.open(
			`${counterPath}?${SECOND_WINDOW_QUERY}`,
			"_blank",
			"popup,width=460,height=760",
		);
		return Component.noop;
	}),
);

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
export const GenerateOrderKey = Command.make(
	"GenerateOrderKey",
	{ args: {} },
	() =>
		Effect.sync(() =>
			Message.GeneratedOrderKey({
				key: `${pick(KEY_ADJECTIVES)}-${pick(KEY_NOUNS)}-${crypto.randomUUID().slice(0, 4)}`,
			}),
		),
);

export class LoadOrder extends Command.Service<LoadOrder>()("order/LoadOrder", {
	args: { key: Schema.String },
	success: Message,
}) {
	static readonly layer = this.toLayer(
		Effect.gen(function* () {
			const orderHandle = yield* order;
			return ({ key }) =>
				Effect.gen(function* () {
					const { steps, wokeAt } = yield* orderHandle(key).GetStatus();
					const loadedAt = yield* Clock.currentTimeMillis;
					return Message.SucceededLoadOrder({ key, steps, wokeAt, loadedAt });
				}).pipe(
					Effect.catch((error) =>
						Effect.succeed(Message.FailedLoadOrder({ error: error.message })),
					),
				);
		}),
	);
}

/** Stops the order's actor, and notes when, so the page can mark the moment on the timeline. */
export class StopActor extends Command.Service<StopActor>()("order/StopActor", {
	args: { key: Schema.String },
	success: Message,
}) {
	static readonly layer = this.toLayer(
		Effect.gen(function* () {
			const orderHandle = yield* order;
			return ({ key }) =>
				Effect.gen(function* () {
					yield* orderHandle(key).Stop();
					const stoppedAt = yield* Clock.currentTimeMillis;
					return Message.SucceededStopActor({ key, stoppedAt });
				}).pipe(
					Effect.catch((error) =>
						Effect.succeed(Message.FailedStopActor({ error: error.message })),
					),
				);
		}),
	);
}

/** Waits until the stopped actor's sleep is over, so the page connects again only after it. */
export const WaitForSleepEnd = Command.make(
	"WaitForSleepEnd",
	{
		args: {
			key: Schema.String,
			wakesBefore: Schema.Number,
			delayMs: Schema.Number,
		},
	},
	({ key, wakesBefore, delayMs }) =>
		Effect.sleep(Duration.millis(delayMs)).pipe(
			Effect.as(Message.CompletedWaitForSleepEnd({ key, wakesBefore })),
		),
);

/** Reloads the page after the screen has switched off. */
export const ReloadPage = Command.make("ReloadPage", { args: {} }, () =>
	Effect.sleep(Duration.millis(POWER_OFF_MS)).pipe(
		Effect.andThen(Effect.sync(() => location.reload())),
		Effect.as(Component.noop),
	),
);
