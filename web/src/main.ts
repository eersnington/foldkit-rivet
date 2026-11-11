import { Client } from "@rivetkit/effect";
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { Command, type Runtime, Subscription, type Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Counter, Order, OrderStatus, OrderStep } from "../../shared/api.ts";

const COUNTER_KEY = "demo";
const ORDER_KEYS_STORAGE_KEY = "order-keys";
const MAX_ORDERS = 3;
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

export const Model = Schema.Struct({
	maybeCount: Schema.Option(Schema.Number),
	connection: ConnectionState,
	orders: Schema.Array(OrderModel),
	maybeLastError: Schema.Option(Schema.String),
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
		ChangedCount: ({ count }) => ({ model: withCount(model, count) }),
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
		}),
		FailedOrderConnection: ({ error }) => ({ model: withError(model, error) }),
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

const connectionLabel = ConnectionState.match({
	Connecting: () => "Connecting",
	Connected: () => "Connected",
	Disconnected: () => "Disconnected",
});

const connectionDotClass = ConnectionState.match({
	Connecting: () => "bg-amber-400 animate-pulse",
	Connected: () => "bg-emerald-500",
	Disconnected: () => "bg-red-500",
});

const cardClass =
	"w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-6 flex flex-col gap-4";
const buttonClass =
	"w-full rounded-lg bg-orange-500 px-4 py-2.5 font-medium text-zinc-950 transition hover:bg-orange-400";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: "Rivet + Effect + Foldkit",
	body: h.div(
		[
			h.Class(
				"min-h-screen bg-zinc-950 text-zinc-100 flex justify-center p-6",
			),
		],
		[
			h.div(
				[h.Class("w-full max-w-sm flex flex-col gap-4")],
				[
					counterView(model, h),
					ordersView(model.orders, h),
					h.p(
						[h.Id("error"), h.Class("min-h-5 text-center text-sm text-red-400")],
						[Option.getOrElse(model.maybeLastError, () => "")],
					),
				],
			),
		],
	),
});

const counterView = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class(`${cardClass} items-center`)],
		[
			h.div(
				[h.Class("flex items-center gap-2 text-sm text-zinc-400")],
				[
					h.span(
						[
							h.Class(
								`h-2 w-2 rounded-full ${connectionDotClass(model.connection)}`,
							),
						],
						[],
					),
					h.span([h.Id("connection")], [connectionLabel(model.connection)]),
				],
			),
			h.div(
				[h.Id("count"), h.Class("text-6xl font-semibold tabular-nums")],
				[
					Option.match(model.maybeCount, {
						onNone: () => "…",
						onSome: (count) => count.toString(),
					}),
				],
			),
			h.button(
				[
					h.Id("increment"),
					h.OnClick(Message.ClickedIncrement()),
					h.Class(buttonClass),
				],
				["Increment"],
			),
		],
	);

const ordersView = (
	orders: ReadonlyArray<OrderModel>,
	h: HtmlBuilder<Message>,
): Html =>
	h.div(
		[h.Class(cardClass)],
		[
			h.button(
				[
					h.Id("start-order"),
					h.OnClick(Message.ClickedStartOrder()),
					h.Class(buttonClass),
				],
				["Start order"],
			),
			...orders.map((order) => orderView(order, h)),
		],
	);

const orderView = (order: OrderModel, h: HtmlBuilder<Message>): Html =>
	h.keyed("div")(
		order.key,
		[h.DataAttribute("order", order.key), h.Class("flex flex-col gap-1")],
		[
			h.div([h.Class("font-mono text-xs text-zinc-500")], [`order ${order.key}`]),
			h.div(
				[h.Class("grid grid-cols-3 gap-2")],
				OrderStatus.literals.map((status) => {
					const maybeStep = order.steps.find((step) => step.status === status);
					return h.div(
						[
							h.DataAttribute("step", status),
							h.DataAttribute("done", String(maybeStep !== undefined)),
							h.Class(
								`rounded-lg border px-2 py-1.5 text-center text-sm ${
									maybeStep === undefined
										? "border-zinc-800 text-zinc-600"
										: "border-emerald-700 bg-emerald-950 text-emerald-300"
								}`,
							),
						],
						[
							h.div([], [status]),
							h.div(
								[h.Class("text-xs tabular-nums opacity-70")],
								[
									maybeStep === undefined
										? "…"
										: new Date(maybeStep.at).toLocaleTimeString("en-GB"),
								],
							),
						],
					);
				}),
			),
		],
	);
