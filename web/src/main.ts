import { Client } from "@rivetkit/effect";
import { Clock, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { Command, type Runtime, Subscription, type Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Counter, Order, OrderStatus, OrderStep } from "../../shared/api.ts";
import {
	type Footprint,
	groundView,
	isoDefs,
	planRect,
	slab,
	slabView,
	viewBoxFor,
} from "./iso.ts";

const COUNTER_KEY = "demo";
const ORDER_KEYS_STORAGE_KEY = "order-keys";
const MAX_ORDERS = 3;
const MAX_FEED_EVENTS = 8;
const RECONNECT_DELAY = "3 seconds";

// RESOURCES

const ClientConfig = Schema.Struct({
	endpoint: Schema.String,
	namespace: Schema.String,
});

/** The server builds `/config.json` from its environment at runtime. */
const fetchClientConfig = Effect.tryPromise(() =>
	fetch("/config.json").then((response) => response.json()),
).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ClientConfig)));

/**
 * The server issues a short-lived token for the browser. The token is `null`
 * when the control plane needs none, for example a local one.
 */
const fetchToken = async (forceRefresh: boolean): Promise<string | null> => {
	const response = await fetch(forceRefresh ? "/token?refresh" : "/token");
	if (!response.ok) throw new Error(`/token answered ${response.status}`);
	const { token } = (await response.json()) as { token: string | null };
	return token;
};

/**
 * `getToken` must resolve to a nonempty string, so it cannot say "no token".
 * The first read of `/token` decides if the client gets a `getToken` at all.
 */
const getToken: NonNullable<Client.Options["getToken"]> = async ({
	forceRefresh,
}) => {
	const token = await fetchToken(forceRefresh);
	if (token === null) throw new Error("/token has no token");
	return token;
};

/** One Rivet client for the app. A config that cannot load crashes the app. */
export const resources = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* fetchClientConfig;
		const token = yield* Effect.tryPromise(() => fetchToken(false));
		return Client.layer(token === null ? config : { ...config, getToken });
	}).pipe(Effect.orDie),
);

const counter = Counter.client.pipe(
	Effect.map((client) => client.getOrCreate(COUNTER_KEY)),
);

const order = (key: string) =>
	Order.client.pipe(Effect.map((client) => client.getOrCreate(key)));

// FLAGS

const OrderKeys = Schema.Array(Schema.String);
const OrderKeysJson = Schema.fromJsonString(Schema.toCodecJson(OrderKeys));

export const Flags = Schema.Struct({ orderKeys: OrderKeys });
export type Flags = typeof Flags.Type;

/** The order keys survive a reload. The steps come from the workflows. */
export const flags: Effect.Effect<Flags> = Effect.sync(() =>
	localStorage.getItem(ORDER_KEYS_STORAGE_KEY),
).pipe(
	Effect.flatMap(Schema.decodeUnknownEffect(OrderKeysJson)),
	Effect.catch(() => Effect.succeed([])),
	Effect.map((orderKeys) => Flags.make({ orderKeys })),
);

// MODEL

export const ConnectionState = defineTaggedUnion({
	Connecting: {},
	Connected: {},
	Disconnected: {},
});
export type ConnectionState = typeof ConnectionState.Type;

export const OrderModel = Schema.Struct({
	key: Schema.String,
	steps: Schema.Array(OrderStep),
});
export type OrderModel = typeof OrderModel.Type;

/** One event from a live connection, for the event feed. `at` is Unix milliseconds. */
export const FeedEvent = Schema.Struct({
	at: Schema.Number,
	name: Schema.Literals(["CountChanged", "StatusChanged"]),
	text: Schema.String,
});
export type FeedEvent = typeof FeedEvent.Type;

export const Model = Schema.Struct({
	maybeCount: Schema.Option(Schema.Number),
	connection: ConnectionState,
	orders: Schema.Array(OrderModel),
	maybeLastError: Schema.Option(Schema.String),
	/** Newest first, at most `MAX_FEED_EVENTS`. */
	feed: Schema.Array(FeedEvent),
});
export type Model = typeof Model.Type;

const isShipped = (order: OrderModel) =>
	order.steps.some((step) => step.status === "shipped");

// MESSAGE

export const Message = defineMessageUnion({
	ClickedIncrement: {},
	SucceededLoadCount: { count: Schema.Number },
	FailedLoadCount: { error: Schema.String },
	SucceededIncrementCount: { count: Schema.Number },
	FailedIncrementCount: { error: Schema.String },
	OpenedCounterConnection: {},
	ChangedCount: { count: Schema.Number },
	FailedCounterConnection: { error: Schema.String },

	ClickedStartOrder: {},
	GeneratedOrderKey: { key: Schema.String },
	SavedOrderKeys: {},
	OpenedOrderConnection: { key: Schema.String },
	SucceededLoadOrder: { key: Schema.String, steps: Schema.Array(OrderStep) },
	FailedLoadOrder: { error: Schema.String },
	ChangedOrderStatus: { key: Schema.String, step: OrderStep },
	FailedOrderConnection: { error: Schema.String },

	TimestampedFeedEvent: { event: FeedEvent },
});
export type Message = typeof Message.Type;

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Client.Client>;

/**
 * An action result and an event can arrive in either order. The count only
 * grows, so the largest value is the newest.
 */
const withCount = (model: Model, count: number): Model =>
	modifyFields(model, {
		maybeCount: (maybeCount) =>
			Option.some(Math.max(count, Option.getOrElse(maybeCount, () => count))),
		maybeLastError: () => Option.none(),
	});

/** A step can arrive from `GetStatus` and from an event. Keep one of each. */
const withOrderSteps = (
	model: Model,
	key: string,
	steps: ReadonlyArray<OrderStep>,
): Model =>
	modifyFields(model, {
		orders: (orders) =>
			orders.map((order) =>
				order.key === key
					? {
							key,
							steps: [
								...order.steps,
								...steps.filter(
									({ status }) =>
										!order.steps.some((step) => step.status === status),
								),
							],
						}
					: order,
			),
	});

const withError = (model: Model, error: string): Model =>
	modifyFields(model, { maybeLastError: () => Option.some(error) });

export const update = (model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		ClickedIncrement: () => ({ model, commands: [IncrementCount()] }),
		SucceededLoadCount: ({ count }) => ({ model: withCount(model, count) }),
		FailedLoadCount: ({ error }) => ({ model: withError(model, error) }),
		SucceededIncrementCount: ({ count }) => ({
			model: withCount(model, count),
		}),
		FailedIncrementCount: ({ error }) => ({ model: withError(model, error) }),
		// Events sent while the connection was down are lost, so read again.
		OpenedCounterConnection: () => ({
			model: modifyFields(model, {
				connection: () => ConnectionState.Connected(),
			}),
			commands: [LoadCount()],
		}),
		ChangedCount: ({ count }) => ({
			model: withCount(model, count),
			commands: [
				TimestampFeedEvent({ name: "CountChanged", text: `count = ${count}` }),
			],
		}),
		FailedCounterConnection: ({ error }) => ({
			model: modifyFields(withError(model, error), {
				connection: () => ConnectionState.Disconnected(),
			}),
		}),

		ClickedStartOrder: () => ({ model, commands: [GenerateOrderKey()] }),
		// The subscription connects to the new order, and that creates it.
		GeneratedOrderKey: ({ key }) => {
			const orders = [{ key, steps: [] }, ...model.orders].slice(0, MAX_ORDERS);
			return {
				model: modifyFields(model, { orders: () => orders }),
				commands: [SaveOrderKeys({ keys: orders.map((order) => order.key) })],
			};
		},
		SavedOrderKeys: () => ({ model }),
		// The saved steps are the source of truth after a connect or a reload.
		OpenedOrderConnection: ({ key }) => ({
			model,
			commands: [LoadOrder({ key })],
		}),
		SucceededLoadOrder: ({ key, steps }) => ({
			model: withOrderSteps(model, key, steps),
		}),
		FailedLoadOrder: ({ error }) => ({ model: withError(model, error) }),
		ChangedOrderStatus: ({ key, step }) => ({
			model: withOrderSteps(model, key, [step]),
			commands: [
				TimestampFeedEvent({
					name: "StatusChanged",
					text: `${key} → ${step.status}`,
				}),
			],
		}),
		FailedOrderConnection: ({ error }) => ({ model: withError(model, error) }),

		TimestampedFeedEvent: ({ event }) => ({
			model: modifyFields(model, {
				feed: (feed) => [event, ...feed].slice(0, MAX_FEED_EVENTS),
			}),
		}),
	});

// INIT

export const init: Runtime.ApplicationInit<
	Model,
	Message,
	Flags,
	Client.Client
> = ({ orderKeys }) => ({
	model: {
		maybeCount: Option.none(),
		connection: ConnectionState.Connecting(),
		orders: orderKeys.map((key) => ({ key, steps: [] })),
		maybeLastError: Option.none(),
		feed: [],
	},
	commands: [LoadCount()],
});

// COMMAND

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

export const IncrementCount = Command.define("IncrementCount", {
	messages: [Message.SucceededIncrementCount, Message.FailedIncrementCount],
	execute: counter.pipe(
		Effect.flatMap((handle) => handle.Increment({ amount: 1 })),
		Effect.map((count) => Message.SucceededIncrementCount({ count })),
		Effect.catch((error) =>
			Effect.succeed(Message.FailedIncrementCount({ error: error.message })),
		),
	),
});

export const GenerateOrderKey = Command.define("GenerateOrderKey", {
	messages: [Message.GeneratedOrderKey],
	execute: Effect.sync(() =>
		Message.GeneratedOrderKey({ key: crypto.randomUUID().slice(0, 8) }),
	),
});

export const SaveOrderKeys = Command.define("SaveOrderKeys", {
	args: { keys: OrderKeys },
	messages: [Message.SavedOrderKeys],
	execute: ({ keys }) =>
		Effect.sync(() => {
			localStorage.setItem(ORDER_KEYS_STORAGE_KEY, JSON.stringify(keys));
			return Message.SavedOrderKeys();
		}),
});

export const LoadOrder = Command.define("LoadOrder", {
	args: { key: Schema.String },
	messages: [Message.SucceededLoadOrder, Message.FailedLoadOrder],
	execute: ({ key }) =>
		order(key).pipe(
			Effect.flatMap((handle) => handle.GetStatus()),
			Effect.map(({ steps }) => Message.SucceededLoadOrder({ key, steps })),
			Effect.catch((error) =>
				Effect.succeed(Message.FailedLoadOrder({ error: error.message })),
			),
		),
});

/** Stamps an event with the time it arrived, so `update` stays pure. */
export const TimestampFeedEvent = Command.define("TimestampFeedEvent", {
	args: { name: FeedEvent.fields.name, text: Schema.String },
	messages: [Message.TimestampedFeedEvent],
	execute: ({ name, text }) =>
		Clock.currentTimeMillis.pipe(
			Effect.map((at) =>
				Message.TimestampedFeedEvent({ event: { at, name, text } }),
			),
		),
});

// SUBSCRIPTION

/**
 * One live connection to the counter. The stream ends when the connection is
 * lost for good, and then it opens a new connection after a delay.
 */
const counterEvents = Stream.unwrap(
	Effect.gen(function* () {
		const connection = yield* (yield* counter).connect;
		return Stream.concat(
			Stream.succeed(Message.OpenedCounterConnection()),
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
				Stream.succeed(Message.OpenedOrderConnection({ key })),
				connection.events.StatusChanged.pipe(
					Stream.map((step) => Message.ChangedOrderStatus({ key, step })),
				),
			);
		}),
	).pipe(
		Stream.catch((error) =>
			Stream.succeed(Message.FailedOrderConnection({ error: error.message })),
		),
		Stream.repeat(Schedule.spaced(RECONNECT_DELAY)),
	);

export const subscriptions = Subscription.make<
	Model,
	Message,
	Client.Client
>()((entry) => ({
	counterEvents: Subscription.persistentEntry(counterEvents),
	// A shipped order sends no more events, so its connection closes.
	orderEvents: entry(
		{ keys: OrderKeys },
		{
			modelToDependencies: (model) => ({
				keys: model.orders
					.filter((order) => !isShipped(order))
					.map((order) => order.key),
			}),
			dependenciesToStream: ({ keys }) =>
				Stream.mergeAll(keys.map(orderEvents), { concurrency: "unbounded" }),
		},
	),
}));

// VIEW

const SOURCE_URL = "https://github.com/eersnington/foldkit-rivet";

const formatTime = (at: number) => new Date(at).toLocaleTimeString("en-GB");

const connectionLabel = ConnectionState.match({
	Connecting: () => "Connecting",
	Connected: () => "Connected",
	Disconnected: () => "Disconnected",
});

const connectionDotClass = ConnectionState.match({
	Connecting: () => "bg-ink-faint animate-breathe",
	Connected: () => "bg-highlight",
	Disconnected: () => "border border-ink-faint",
});

const focusClass =
	"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight";
const panelClass =
	"rounded-[20px] border border-ink/10 bg-surface p-5 sm:p-6 dark:bg-surface/55";
const primaryButtonClass = `inline-flex h-11 w-full items-center justify-center rounded-xl bg-highlight-deep px-5 text-[15px] font-semibold text-white transition hover:brightness-110 active:translate-y-px active:brightness-95 disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink-faint ${focusClass}`;
const linkClass = `rounded-sm transition hover:text-ink-soft ${focusClass}`;

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: "Rivet · Effect SDK × Foldkit",
	body: h.div(
		[h.Class("min-h-screen bg-paper font-sans text-ink")],
		[
			h.div(
				[
					h.Class(
						"mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-10 pt-4 sm:px-8 sm:pt-6",
					),
				],
				[
					isoDefs(h),
					topBarView(model.connection, h),
					introView(h),
					errorView(model.maybeLastError, h),
					h.main(
						[h.Class("grid gap-4 md:grid-cols-2 md:gap-5")],
						[counterView(model.maybeCount, h), ordersView(model.orders, h)],
					),
					feedView(model.feed, h),
					footerView(h),
				],
			),
		],
	),
});

const topBarView = (connection: ConnectionState, h: HtmlBuilder<Message>) =>
	h.header(
		[
			h.Class(
				"flex items-center justify-between gap-3 border-b border-ink/10 pb-4",
			),
		],
		[
			h.div(
				[h.Class("flex min-w-0 items-baseline gap-2.5")],
				[
					h.span(
						[h.Class("text-[17px] font-semibold tracking-tight")],
						["Rivet"],
					),
					h.span(
						[h.Class("truncate text-sm font-medium text-ink-faint")],
						["Effect SDK × Foldkit"],
					),
				],
			),
			h.div(
				[
					h.Class(
						"flex shrink-0 items-center gap-2 rounded-full border border-ink/10 bg-surface py-1.5 pl-2.5 pr-3 dark:bg-surface/55 text-[13px] font-medium text-ink-soft",
					),
				],
				[
					h.span(
						[h.Class("relative flex size-2"), h.AriaHidden(true)],
						[
							...(connection._tag === "Connected"
								? [
										h.span(
											[
												h.Class(
													"absolute inset-0 rounded-full bg-highlight animate-ring",
												),
											],
											[],
										),
									]
								: []),
							h.span(
								[
									h.Class(
										`relative size-2 rounded-full ${connectionDotClass(connection)}`,
									),
								],
								[],
							),
						],
					),
					h.span(
						[h.Id("connection"), h.AriaLive("polite")],
						[connectionLabel(connection)],
					),
				],
			),
		],
	);

const introView = (h: HtmlBuilder<Message>) =>
	h.section(
		[h.Class("flex max-w-2xl flex-col gap-2 pt-2")],
		[
			h.h1(
				[
					h.Class(
						"text-2xl font-semibold tracking-tight text-ink sm:text-[28px]",
					),
				],
				["A durable workflow and an actor, live in the browser"],
			),
			h.p(
				[h.Class("text-[15px] leading-relaxed text-ink-faint")],
				[
					"Both are written with the Rivet Effect SDK and called from this Foldkit app with the Rivet Effect client. Open this page in a second tab to see live sync.",
				],
			),
		],
	);

/** `#error` always exists, so tests can read it. It is hidden when empty. */
const errorView = (maybeLastError: Option.Option<string>, h: HtmlBuilder<Message>) =>
	h.section(
		[
			h.Role("status"),
			h.Class(
				Option.isSome(maybeLastError)
					? "flex flex-col gap-1 rounded-2xl border border-ink/10 bg-surface px-4 py-3 dark:bg-surface/55 sm:flex-row sm:items-baseline sm:gap-3"
					: "hidden",
			),
		],
		[
			h.span(
				[
					h.Class(
						"shrink-0 font-mono text-[11px] font-medium uppercase tracking-wider text-ink-faint",
					),
				],
				["Last error"],
			),
			h.p(
				[h.Id("error"), h.Class("min-w-0 break-words text-sm text-ink-soft")],
				[Option.getOrElse(maybeLastError, () => "")],
			),
		],
	);

const chipsView = (
	chips: ReadonlyArray<{ text: string; code: boolean }>,
	h: HtmlBuilder<Message>,
) =>
	h.ul(
		[h.Class("flex flex-wrap gap-1.5"), h.AriaLabel("Uses")],
		chips.map(({ text, code }) =>
			h.li(
				[
					h.Class(
						`rounded-full border border-ink/10 px-2.5 py-0.5 text-xs font-medium text-ink-faint ${code ? "font-mono" : ""}`,
					),
				],
				[text],
			),
		),
	);

const panelHeaderView = (
	title: string,
	meta: string,
	chips: ReadonlyArray<{ text: string; code: boolean }>,
	h: HtmlBuilder<Message>,
) =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3")],
				[
					h.h2([h.Class("text-base font-semibold text-ink")], [title]),
					h.span([h.Class("font-mono text-xs text-ink-faint")], [meta]),
				],
			),
			chipsView(chips, h),
		],
	);

// The counter slab: a 4 by 4 grid of tiles. One tile rises for each increment,
// and the grid starts over after 16.
const COUNTER_GRID = 4;
const COUNTER_TILE_COUNT = COUNTER_GRID * COUNTER_GRID;
const COUNTER_SLAB: Footprint = { cx: 0, cy: 0, width: 96, depth: 96, radius: 14 };
const COUNTER_SLAB_HEIGHT = 10;
const COUNTER_TILE_HEIGHT = 4;
const counterSlab = slab(COUNTER_SLAB, 0, COUNTER_SLAB_HEIGHT);
const counterViewBox = viewBoxFor(
	COUNTER_SLAB,
	0,
	COUNTER_SLAB_HEIGHT + COUNTER_TILE_HEIGHT,
	8,
);
const counterTiles = Array.from({ length: COUNTER_TILE_COUNT }, (_, index) => {
	const row = Math.floor(index / COUNTER_GRID);
	const column = index % COUNTER_GRID;
	const tile = (size: number, radius: number): Footprint => ({
		cx: -31.5 + 21 * column,
		cy: -31.5 + 21 * row,
		width: size,
		depth: size,
		radius,
	});
	return {
		index,
		flat: tile(15, 3),
		glow: tile(17, 4),
		raised: slab(tile(15, 3), COUNTER_SLAB_HEIGHT, COUNTER_TILE_HEIGHT),
	};
});

const raisedTileCount = (maybeCount: Option.Option<number>) =>
	Option.match(maybeCount, {
		onNone: () => 0,
		onSome: (count) =>
			count <= 0 ? 0 : ((count - 1) % COUNTER_TILE_COUNT) + 1,
	});

const counterIllustration = (raised: number, h: HtmlBuilder<Message>): Html => {
	const isRaised = (index: number) => index < raised;
	return h.svg(
		[
			h.ViewBox(counterViewBox),
			h.AriaHidden(true),
			h.Class("block h-auto w-full overflow-visible"),
		],
		[
			groundView(h, counterSlab),
			slabView(h, counterSlab, "neutral"),
			...counterTiles
				.filter(({ index }) => !isRaised(index))
				.map(({ flat }) => planRect(h, flat, COUNTER_SLAB_HEIGHT, "iso-tile")),
			...counterTiles
				.filter(({ index }) => isRaised(index))
				.map(({ glow }) => planRect(h, glow, COUNTER_SLAB_HEIGHT, "iso-glow")),
			// Back to front, so nearer tiles cover the ones behind them.
			...counterTiles
				.filter(({ index }) => isRaised(index))
				.map(({ index, raised: tile }) =>
					h.keyed("g")(`tile-${index}`, [h.Class("iso-rise")], [
						slabView(h, tile, "accent"),
					]),
				),
		],
	);
};

const counterView = (maybeCount: Option.Option<number>, h: HtmlBuilder<Message>) =>
	h.section(
		[h.Class(`${panelClass} flex flex-col gap-6`)],
		[
			panelHeaderView(
				"Counter actor",
				`key ${COUNTER_KEY}`,
				[
					{ text: "Actor.make", code: true },
					{ text: "SQLite", code: false },
					{ text: "events", code: false },
				],
				h,
			),
			h.div(
				[
					h.Class(
						"flex flex-1 flex-col items-center justify-center gap-5 py-2 text-center",
					),
				],
				[
					h.div(
						[h.Class("w-[220px] shrink-0")],
						[counterIllustration(raisedTileCount(maybeCount), h)],
					),
					h.div(
						[h.Class("flex w-full min-w-0 flex-col items-center gap-1")],
						[
							h.div(
								[
									h.Id("count"),
									h.AriaLive("polite"),
									h.Class(
										"text-7xl font-medium leading-none tracking-tight tabular-nums",
									),
								],
								[
									Option.match(maybeCount, {
										onNone: () => "…",
										onSome: (count) => count.toString(),
									}),
								],
							),
							h.p(
								[h.Class("pt-3 text-sm text-ink-faint")],
								[
									"Synced live via ",
									h.code([h.Class("font-mono text-[13px] text-ink-soft")], [
										"CountChanged",
									]),
								],
							),
							h.p(
								[h.Class("font-mono text-[11px] text-ink-faint")],
								[`one tile per increment, ${COUNTER_TILE_COUNT} per grid`],
							),
						],
					),
				],
			),
			h.div(
				[],
				[
					h.button(
						[
							h.Id("increment"),
							h.Type("button"),
							h.OnClick(Message.ClickedIncrement()),
							h.Class(primaryButtonClass),
						],
						["Increment"],
					),
				],
			),
		],
	);

const ordersView = (orders: ReadonlyArray<OrderModel>, h: HtmlBuilder<Message>) =>
	h.section(
		[h.Class(`${panelClass} flex flex-col gap-6`)],
		[
			panelHeaderView(
				"Order workflow",
				`last ${MAX_ORDERS}`,
				[
					{ text: "Workflow.make", code: true },
					{ text: "durable steps", code: false },
					{ text: "sleeps", code: false },
				],
				h,
			),
			h.div(
				[],
				[
					h.button(
						[
							h.Id("start-order"),
							h.Type("button"),
							h.OnClick(Message.ClickedStartOrder()),
							h.Class(primaryButtonClass),
						],
						["Start order"],
					),
				],
			),
			orders.length === 0
				? h.p(
						[
							h.Class(
								"rounded-2xl border border-dashed border-ink/10 px-4 py-6 text-center text-sm leading-relaxed text-ink-faint",
							),
						],
						[
							"No orders yet. Start one and watch each step land, even after a reload.",
						],
					)
				: h.ul(
						[h.Class("flex flex-col gap-3")],
						orders.map((order) => orderView(order, h)),
					),
		],
	);

const orderView = (order: OrderModel, h: HtmlBuilder<Message>): Html => {
	const shipped = isShipped(order);
	const maybeStepAt = (status: OrderStatus) =>
		order.steps.find((step) => step.status === status);
	const waitingIndex = OrderStatus.literals.findIndex(
		(status) => maybeStepAt(status) === undefined,
	);
	return h.keyed("li")(
		order.key,
		[
			h.DataAttribute("order", order.key),
			h.Class("rounded-2xl border border-ink/10 bg-paper/60 px-4 pb-4 pt-3.5"),
		],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-3 pb-3")],
				[
					h.span(
						[h.Class("font-mono text-[13px] text-ink-soft")],
						[order.key],
					),
					h.span(
						[
							h.Class(
								`flex items-center gap-1.5 text-xs font-medium ${shipped ? "text-ink-faint" : "text-ink-soft"}`,
							),
						],
						[
							h.span(
								[
									h.AriaHidden(true),
									h.Class(
										`size-1.5 rounded-full ${shipped ? "bg-ink/25" : "bg-highlight animate-breathe"}`,
									),
								],
								[],
							),
							shipped ? "shipped" : "running",
						],
					),
				],
			),
			h.ol(
				[h.Class("grid grid-cols-3")],
				OrderStatus.literals.map((status, index) =>
					stepView(status, index, maybeStepAt(status), index === waitingIndex, h),
				),
			),
		],
	);
};

// Each step is a small slab. A finished step has a raised accent tile on it.
const STEP_SLAB: Footprint = { cx: 0, cy: 0, width: 40, depth: 40, radius: 8 };
const STEP_SLAB_HEIGHT = 6;
const STEP_TILE_HEIGHT = 5;
const stepSlab = slab(STEP_SLAB, 0, STEP_SLAB_HEIGHT);
const stepTile = (size: number, radius: number): Footprint => ({
	cx: 0,
	cy: 0,
	width: size,
	depth: size,
	radius,
});
const stepRaisedTile = slab(stepTile(22, 4), STEP_SLAB_HEIGHT, STEP_TILE_HEIGHT);
const stepViewBox = viewBoxFor(
	STEP_SLAB,
	0,
	STEP_SLAB_HEIGHT + STEP_TILE_HEIGHT,
	5,
);

type StepState = "done" | "waiting" | "future";

const stepIllustration = (state: StepState, h: HtmlBuilder<Message>): Html =>
	h.svg(
		[
			h.ViewBox(stepViewBox),
			h.AriaHidden(true),
			h.Class("block h-auto w-[72px] overflow-visible"),
		],
		[
			groundView(h, stepSlab),
			slabView(h, stepSlab, "neutral"),
			...(state === "done"
				? [
						planRect(h, stepTile(24, 5), STEP_SLAB_HEIGHT, "iso-glow"),
						slabView(h, stepRaisedTile, "accent"),
					]
				: state === "waiting"
					? [
							planRect(h, stepTile(30, 7), STEP_SLAB_HEIGHT, "iso-waiting-halo"),
							planRect(h, stepTile(22, 4), STEP_SLAB_HEIGHT, "iso-waiting"),
						]
					: [planRect(h, stepTile(22, 4), STEP_SLAB_HEIGHT, "iso-tile-future")]),
		],
	);

const stepView = (
	status: OrderStatus,
	index: number,
	maybeStep: OrderStep | undefined,
	isWaiting: boolean,
	h: HtmlBuilder<Message>,
): Html => {
	const state: StepState =
		maybeStep !== undefined ? "done" : isWaiting ? "waiting" : "future";
	return h.li(
		[
			h.DataAttribute("step", status),
			h.DataAttribute("done", String(state === "done")),
			...(isWaiting ? [h.AriaCurrent("step")] : []),
			h.Class("flex flex-col items-center gap-1.5 text-center"),
		],
		[
			h.div(
				[h.Class("relative flex w-full justify-center")],
				[
					...(index > 0
						? [
								h.span(
									[
										h.AriaHidden(true),
										h.Class(
											`absolute top-[46%] left-[calc(-50%_+_40px)] right-[calc(50%_+_40px)] border-t ${state === "done" ? "border-ink/30" : "border-dashed border-ink/15"}`,
										),
									],
									[],
								),
							]
						: []),
					stepIllustration(state, h),
				],
			),
			h.span(
				[
					h.Class(
						`text-sm font-medium ${state === "future" ? "text-ink-faint" : "text-ink"}`,
					),
				],
				[status],
			),
			h.span(
				[
					h.Class(
						`font-mono text-[11px] tabular-nums ${state === "waiting" ? "text-ink-soft" : "text-ink-faint"}`,
					),
				],
				[
					state === "done" && maybeStep !== undefined
						? formatTime(maybeStep.at)
						: state === "waiting"
							? "waiting"
							: "—",
				],
			),
		],
	);
};

const feedView = (feed: ReadonlyArray<FeedEvent>, h: HtmlBuilder<Message>) =>
	h.section(
		[h.Class(`${panelClass} flex flex-col gap-4`)],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3")],
				[
					h.h2([h.Class("text-base font-semibold text-ink")], ["Event feed"]),
					h.span(
						[h.Class("font-mono text-xs text-ink-faint")],
						[`last ${MAX_FEED_EVENTS}`],
					),
				],
			),
			feed.length === 0
				? h.p(
						[h.Class("py-2 text-sm text-ink-faint")],
						["Events appear here as they arrive."],
					)
				: h.ol(
						[h.Id("feed"), h.Class("flex flex-col divide-y divide-ink/[0.06]")],
						feed.map((event, index) =>
							h.keyed("li")(
								`${event.at}-${event.name}-${event.text}`,
								[
									h.DataAttribute("event", event.name),
									h.Class(
										"grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 py-2.5 font-mono text-[12px] sm:gap-x-5 sm:text-[13px]",
									),
								],
								[
									h.span(
										[h.Class("flex items-center gap-2.5 tabular-nums text-ink-faint")],
										[
											h.span(
												[
													h.AriaHidden(true),
													h.Class(
														`size-1.5 rounded-full ${index === 0 ? "bg-highlight" : "bg-ink/20"}`,
													),
												],
												[],
											),
											formatTime(event.at),
										],
									),
									h.span([h.Class("text-ink-soft")], [event.name]),
									h.span([h.Class("truncate text-ink-faint")], [event.text]),
								],
							),
						),
					),
		],
	);

const footerView = (h: HtmlBuilder<Message>) =>
	h.footer(
		[
			h.Class(
				"flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink/10 pt-5 text-sm text-ink-faint",
			),
		],
		[
			footerLink("Source", SOURCE_URL, h),
			footerLink("Rivet", "https://rivet.dev", h),
			footerLink("Foldkit", "https://foldkit.dev", h),
		],
	);

const footerLink = (text: string, href: string, h: HtmlBuilder<Message>) =>
	h.a(
		[h.Href(href), h.Target("_blank"), h.Rel("noreferrer"), h.Class(linkClass)],
		[text],
	);
