import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { Message } from "../message.ts";
import { ConnectionState, type Model } from "../model.ts";
import { AppRoute, counterRouter, orderRouter } from "../route.ts";
import { isDone } from "../workflow.ts";
import { counterSlideView } from "./counter.ts";
import { orderSlideView } from "./order.ts";
import { focusClass, SOURCE_URL } from "./shared.ts";

const connectionLabel = ConnectionState.match({
	Connecting: () => "Connecting",
	Connected: () => "Connected",
	Disconnected: () => "Disconnected",
});

const connectionDotClass = ConnectionState.match({
	Connecting: () => "bg-paper/50 blink",
	Connected: () => "bg-orange",
	Disconnected: () => "border border-paper/60",
});

const barLinkClass = `hover:text-paper ${focusClass}`;

type Tab = {
	readonly href: string;
	readonly number: string;
	readonly title: string;
	readonly isActive: boolean;
	/** A mark while something runs, or for a moment after something changed. */
	readonly activity: Option.Option<{
		readonly key: string;
		readonly isOngoing: boolean;
	}>;
};

const tabView = (
	{ href, number, title, isActive, activity }: Tab,
	h: HtmlBuilder<Message>,
): Html =>
	h.a(
		[
			h.Href(href),
			...(isActive ? [h.AriaCurrent("page")] : []),
			h.Class(
				`topbar-tab ${isActive ? "topbar-tab-active" : ""} ${focusClass}`,
			),
		],
		[
			h.span([h.Class("hidden opacity-50 sm:inline")], [number]),
			title,
			Option.match(activity, {
				onNone: () => h.keyed("span")("quiet", [h.Class("size-2")], []),
				onSome: ({ key, isOngoing }) =>
					h.keyed("span")(
						key,
						[
							h.AriaHidden(true),
							h.Class(`size-2 bg-orange ${isOngoing ? "blink" : "pop"}`),
						],
						[],
					),
			}),
		],
	);

const tabsView = (model: Model, h: HtmlBuilder<Message>): Html => {
	const isOrderRunning = model.orders.some(
		(order) => order.isKnown && !isDone(order.steps),
	);
	return h.nav(
		[h.AriaLabel("Demos"), h.Class("flex items-center gap-1 md:col-start-2")],
		[
			tabView(
				{
					href: orderRouter(),
					number: "01",
					title: "Order",
					isActive: model.route._tag === "Order",
					activity: isOrderRunning
						? Option.some({ key: "running", isOngoing: true })
						: Option.none(),
				},
				h,
			),
			tabView(
				{
					href: counterRouter(),
					number: "02",
					title: "Counter",
					isActive: model.route._tag === "Counter",
					activity: Option.map(model.counter.maybeLastChange, ({ count }) => ({
						key: `changed-${count}`,
						isOngoing: false,
					})),
				},
				h,
			),
		],
	);
};

const topBarView = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.header(
		[h.Class("topbar")],
		[
			h.p(
				[h.Class("hidden truncate text-paper md:block")],
				["Rivet × Effect × Foldkit"],
			),
			tabsView(model, h),
			h.div(
				[
					h.Class(
						"flex items-center justify-end gap-4 sm:gap-5 md:col-start-3",
					),
				],
				[
					h.a(
						[
							h.Href(SOURCE_URL),
							h.Target("_blank"),
							h.Rel("noreferrer"),
							h.Class(`hidden lg:block ${barLinkClass}`),
						],
						["GitHub"],
					),
					h.button(
						[
							h.Id("sound"),
							h.Type("button"),
							h.AriaPressed(String(model.isSoundOn)),
							h.OnClick(Message.ClickedSound()),
							h.Class(`uppercase ${barLinkClass}`),
						],
						[model.isSoundOn ? "Sound on" : "Sound off"],
					),
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.span(
								[
									h.AriaHidden(true),
									h.Class(`size-2 ${connectionDotClass(model.connection)}`),
								],
								[],
							),
							h.span(
								[
									h.Id("connection"),
									h.AriaLive("polite"),
									h.Class("hidden sm:inline"),
								],
								[connectionLabel(model.connection)],
							),
						],
					),
				],
			),
		],
	);

/** `#error` always exists, so tests can read it. It is hidden when empty. */
const errorView = (
	maybeError: Option.Option<string>,
	h: HtmlBuilder<Message>,
): Html =>
	h.section(
		[
			h.Role("status"),
			h.Class(Option.isSome(maybeError) ? "error fade-in" : "hidden"),
		],
		[
			h.span([h.Class("shrink-0")], ["Error"]),
			h.p(
				[h.Id("error"), h.Class("min-w-0 break-words normal-case")],
				[Option.getOrElse(maybeError, () => "")],
			),
		],
	);

const notFoundView = (path: string, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("slide gap-4 uppercase")],
		[
			h.p([h.Class("text-ink/55")], [`No page at ${path}`]),
			h.a(
				[h.Href(orderRouter()), h.Class(`text-orange-text ${focusClass}`)],
				["Open the Order demo →"],
			),
		],
	);

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: "Rivet × Effect × Foldkit",
	body: h.div(
		[h.Class(`page ${model.isReloading ? "power-off" : ""}`)],
		[
			topBarView(model, h),
			errorView(model.maybeError, h),
			h.main(
				[h.Class("stage")],
				[
					// A new element for each demo, so the open one draws in.
					h.keyed("div")(
						model.route._tag,
						[h.Class("rise-in flex w-full justify-center")],
						[
							AppRoute.match(model.route, {
								Order: () =>
									orderSlideView(
										model,
										model.feed.filter(({ name }) => name === "StatusChanged"),
										h,
									),
								Counter: () =>
									counterSlideView(
										model.counter,
										model.feed.filter(({ name }) => name === "CountChanged"),
										h,
									),
								NotFound: ({ path }) => notFoundView(path, h),
							}),
						],
					),
				],
			),
		],
	),
});
