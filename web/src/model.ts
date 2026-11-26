import { UiSchema } from "@effect/ui";
import { Option, Schema } from "effect";
import { OrderStep } from "../../shared/api.ts";
import { AppRoute } from "./route.ts";
import { isDone } from "./workflow.ts";

// SETTINGS

/** What the page saves, so it survives a reload. */
export const Settings = Schema.Struct({
	orderKeys: Schema.Array(Schema.String),
	isSoundOn: Schema.Boolean,
});
export type Settings = typeof Settings.Type;

/**
 * Sound starts off. Opening audio stalls the page on first use, so it runs
 * only after the visitor turns sound on, and the choice is saved.
 */
export const DEFAULT_SETTINGS: Settings = { orderKeys: [], isSoundOn: false };

// ORDER

/** One run of the `Order` workflow, as this page knows it. */
export const OrderRun = Schema.Struct({
	key: Schema.String,
	/** The steps the workflow saved, from `GetStatus` and from `StatusChanged`. */
	steps: Schema.Array(OrderStep),
	/** How this page learned the latest step: it read it, or an event brought it. */
	latestFrom: Schema.Literals(["read", "event"]),
	/** How much of the current sleep had passed when this page learned the latest step. */
	sleptMs: Schema.Number,
	/** The page read the key from its settings, so the run started before this page load. */
	isRestored: Schema.Boolean,
	/**
	 * The page knows where the run is: it started the run, or it has read the
	 * saved steps. Only a known run that is not done gets a live connection.
	 */
	isKnown: Schema.Boolean,
	/** Where the run was, in ms from its start, when this page loaded during it. */
	maybeJoinedAtMs: Schema.Option(Schema.Number),
	/** When each instance of the order's actor started, in Unix ms, as the page last read it. */
	wokeAt: Schema.Array(Schema.Number),
	/**
	 * The page holds no connection to the run. After a stop it lets go, so no
	 * client wakes the actor, until the visitor reconnects or the sleep ends.
	 */
	isDisconnected: Schema.Boolean,
	/**
	 * The visitor stopped the actor: where the run was then, in ms from its
	 * start, and how many wakes the page had read before. More wakes later
	 * mean the actor started again.
	 */
	maybeStop: Schema.Option(
		Schema.Struct({ atMs: Schema.Number, wakesBefore: Schema.Number }),
	),
});
export type OrderRun = typeof OrderRun.Type;

// COUNTER

export const IncrementResult = Schema.Struct({
	count: Schema.Number,
	tookMs: Schema.Number,
});
export type IncrementResult = typeof IncrementResult.Type;

/** `BURST_SIZE` calls to `Increment` at once. `results` are in the order they came back. */
export const Burst = Schema.Struct({
	id: Schema.Number,
	results: Schema.Array(IncrementResult),
});
export type Burst = typeof Burst.Type;

export const CounterState = Schema.Struct({
	maybeCount: Schema.Option(Schema.Number),
	/** `Increment` calls of this page whose `CountChanged` has not come yet. */
	pendingIncrements: Schema.Number,
	/** How many times the viewer pressed the counter. Each press shows a "+1". */
	presses: Schema.Number,
	/** How many bursts this page started. The next burst takes this as its id. */
	bursts: Schema.Number,
	maybeBurst: Schema.Option(Burst),
	/** The latest `Increment` calls of this page, oldest first, at most `MAX_RECENT_CALLS`. */
	recentCalls: Schema.Array(IncrementResult),
	/** The latest `CountChanged`, and if a call of another client caused it. */
	maybeLastChange: Schema.Option(
		Schema.Struct({ count: Schema.Number, isRemote: Schema.Boolean }),
	),
});
export type CounterState = typeof CounterState.Type;

// FEED

/** One event from a live connection. `at` is Unix ms. */
export const FeedEvent = Schema.Struct({
	at: Schema.Number,
	name: Schema.Literals(["CountChanged", "StatusChanged"]),
	text: Schema.String,
	/** Where the event came from: `this window`, `another window`, or an order key. */
	source: Schema.String,
});
export type FeedEvent = typeof FeedEvent.Type;

// MODEL

export const ConnectionState = UiSchema.TaggedEnum({
	Connecting: {},
	Connected: {},
	Disconnected: {},
});
export type ConnectionState = typeof ConnectionState.Type;

export const Model = Schema.Struct({
	route: AppRoute,
	/** The connection to the counter. */
	connection: ConnectionState,
	maybeError: Schema.Option(Schema.String),
	isSoundOn: Schema.Boolean,
	/**
	 * The page is the second window that the counter opens. It starts with
	 * sound off, so two windows do not play every sound twice, and it saves
	 * no settings, so it never changes the first window's.
	 */
	isSecondWindow: Schema.Boolean,
	/** The viewer pressed a key or a pointer on the page, so the browser allows audio. */
	hasInteracted: Schema.Boolean,
	/** The screen is switching off before the page reloads. */
	isReloading: Schema.Boolean,
	/** Newest first, at most `MAX_ORDERS`. */
	orders: Schema.Array(OrderRun),
	counter: CounterState,
	/** Newest first, at most `MAX_FEED_EVENTS`. */
	feed: Schema.Array(FeedEvent),
});
export type Model = typeof Model.Type;

/** The visitor stopped the actor, and the page has not seen it start again yet. */
export const isStopped = (run: OrderRun) =>
	Option.exists(
		run.maybeStop,
		({ wakesBefore }) => run.wokeAt.length <= wakesBefore,
	);

/** When the actor first started after the stop, in Unix ms, once the page has read it. */
export const wokeAfterStop = (run: OrderRun): Option.Option<number> =>
	Option.flatMap(run.maybeStop, ({ wakesBefore }) =>
		Option.fromNullishOr(run.wokeAt[wakesBefore]),
	);

/** The order the page follows: the newest one that still runs, or else the newest one. */
export const followedOrder = (model: Model): Option.Option<OrderRun> =>
	Option.orElse(
		Option.fromNullishOr(model.orders.find((order) => !isDone(order.steps))),
		() => Option.fromNullishOr(model.orders[0]),
	);

export const settingsOf = (model: Model): Settings => ({
	orderKeys: model.orders.map((order) => order.key),
	isSoundOn: model.isSoundOn,
});
