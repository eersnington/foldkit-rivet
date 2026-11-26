import { Router, Subscription } from "@effect/ui";
import { HtmlSubscription } from "@effect/ui/html";
import { Effect, Schedule, Stream } from "effect";
import { counter, order } from "./client.ts";
import { RECONNECT_DELAY } from "./constant.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { AppRoute } from "./route.ts";
import { holdSpeaker } from "./sound.ts";
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
			const connection = yield* (yield* order)(key).connect;
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
const interacted = () => Message.InteractedWithPage();

export const subscriptions = ({ model }: { readonly model: Model }) => [
	Router.subscription(AppRoute, model.route, (route) =>
		Message.ChangedRoute({ route }),
	),
	Subscription.make("counterEvents", counterEvents),
	// A finished order sends no more events, so its connection closes.
	...model.orders
		.filter((run) => run.isKnown && !run.isDisconnected && !isDone(run.steps))
		.map((run) => Subscription.make("orderEvents", run.key, orderEvents)),
	!model.hasInteracted && HtmlSubscription.onDocument("keydown", interacted),
	!model.hasInteracted && HtmlSubscription.onDocument("pointerup", interacted),
	model.isSoundOn &&
		model.hasInteracted &&
		Subscription.make("speaker", holdSpeaker),
];
