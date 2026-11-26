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
		/** When each instance of this order's actor started, in Unix ms, oldest first. */
		wokeAt: Schema.Array(Schema.Number),
	}),
});

/**
 * Stops this order's actor while it runs. Its memory and connections go,
 * and only its SQLite and workflow history stay. RivetKit starts it again
 * when the workflow's sleep ends, or earlier if a client connects.
 */
export const Stop = Action.make("Stop");

export const StatusChanged = Event.make("StatusChanged", {
	payload: OrderStep.fields,
});

export const Order = Workflow.make("Order", {
	actions: [GetStatus, Stop],
	events: [StatusChanged],
});
