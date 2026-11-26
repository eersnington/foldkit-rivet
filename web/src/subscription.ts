import type { Client } from "@rivetkit/effect";
import { Effect, Schedule, Schema, Stream } from "effect";
import { Dom, Subscription } from "foldkit";
import { counter, order } from "./client.ts";
import { RECONNECT_DELAY } from "./constant.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { isDone } from "./workflow.ts";

/**
 * One live connection to the counter. The stream ends when the connection is
 * lost for good, and then it opens a new connection after a delay.
 */
const counterEvents = Stream.unwrap(
	Effect.gen(function* () {
		const connection = yield* (yield* counter).connect;
		return Stream.concat(
			Stream.succeed(Message.ConnectedCounter()),
			connection.events.CountChanged.pipe(
				Stream.map(({ count }) => Message.ChangedCount({ count })),
			),
		);
	}),
).pipe(
	Stream.catch((error) =>
		Stream.succeed(Message.FailedCounterConnection({ error: error.message })),
	),
	Stream.repeat(Schedule.spaced(RECONNECT_DELAY)),
);

/** One live connection to one order workflow. */
const orderEvents = (key: string) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const connection = yield* (yield* order(key)).connect;
			return Stream.concat(
				Stream.succeed(Message.ConnectedOrder({ key })),
				connection.events.StatusChanged.pipe(
					Stream.map((step) => Message.ChangedOrderStatus({ key, step })),
				),
			);
		}),
	).pipe(
		Stream.catch((error) =>
			Stream.succeed(
				Message.FailedOrderConnection({ key, error: error.message }),
			),
		),
		Stream.repeat(Schedule.spaced(RECONNECT_DELAY)),
	);

/** The first key or pointer press on the page. After it, the browser allows audio. */
const firstInteraction = Stream.merge(
	Dom.streamFromEvent({
		target: window,
		type: "pointerdown",
		mapEvent: () => null,
	}),
	Dom.streamFromEvent({
		target: window,
		type: "keydown",
		mapEvent: () => null,
	}),
).pipe(Stream.take(1), Stream.as(Message.InteractedWithPage()));

export const subscriptions = Subscription.make<Model, Message, Client.Client>()(
	(entry) => ({
		counterEvents: Subscription.persistentEntry(counterEvents),
		// A finished order sends no more events, so its connection closes.
		orderEvents: entry(
			{ keys: Schema.Array(Schema.String) },
			{
				modelToDependencies: (model) => ({
					keys: model.orders
						.filter(
							(run) => run.isKnown && !run.isDisconnected && !isDone(run.steps),
						)
						.map((run) => run.key),
				}),
				dependenciesToStream: ({ keys }) =>
					Stream.mergeAll(keys.map(orderEvents), { concurrency: "unbounded" }),
			},
		),
		firstInteraction: entry(
			{ hasInteracted: Schema.Boolean },
			{
				modelToDependencies: (model) => ({
					hasInteracted: model.hasInteracted,
				}),
				dependenciesToStream: ({ hasInteracted }) =>
					hasInteracted ? Stream.empty : firstInteraction,
			},
		),
	}),
);
