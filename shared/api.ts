// The contracts. The server implements them and the browser calls them.
import { Action, Actor, Event, Workflow } from "@rivetkit/effect";
import { Schema } from "effect";

// Counter: a plain actor.

export const Increment = Action.make("Increment", {
	payload: { amount: Schema.Number },
	success: Schema.Number,
});

export const GetCount = Action.make("GetCount", {
	success: Schema.Number,
});

export const CountChanged = Event.make("CountChanged", {
	payload: { count: Schema.Number },
});

export const Counter = Actor.make("Counter", {
	actions: [Increment, GetCount],
	events: [CountChanged],
});

// Order: a durable workflow. One instance for each order key.

export const OrderStatus = Schema.Literals(["charged", "packed", "shipped"]);
export type OrderStatus = typeof OrderStatus.Type;

/** A finished step. `at` is Unix milliseconds. */
export const OrderStep = Schema.Struct({
	status: OrderStatus,
	at: Schema.Number,
});
export type OrderStep = typeof OrderStep.Type;

export const GetStatus = Action.make("GetStatus", {
	success: Schema.Struct({
		// "new" until the first step finishes.
		status: Schema.Union([Schema.Literal("new"), OrderStatus]),
		steps: Schema.Array(OrderStep),
	}),
});

export const StatusChanged = Event.make("StatusChanged", {
	payload: OrderStep.fields,
});

export const Order = Workflow.make("Order", {
	actions: [GetStatus],
	events: [StatusChanged],
});
