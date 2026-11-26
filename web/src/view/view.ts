import { Option } from "effect";
import { AppDef } from "../app.ts";
import { TITLE } from "../constant.ts";
import { Message } from "../message.ts";
import { ConnectionState, type Model } from "../model.ts";
import { AppRoute, counterPath, orderPath } from "../route.ts";
import { isDone } from "../workflow.ts";
import { CounterSlide } from "./counter.ts";
import { OrderSlide } from "./order.ts";
import { focusClass, type H, type Node, SOURCE_URL } from "./shared.ts";

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

type TabOptions = {
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

/** The Router follows the link. The click only plays the tick. */
const Tab = (
	h: H,
	{ href, number, title, isActive, activity }: TabOptions,
): Node =>
	h.a
		.attrs({ href, "aria-current": isActive ? "page" : undefined })
		.on("click", Message.ClickedTab())
		.class("topbar-tab", isActive && "topbar-tab-active", focusClass)
		.children(
			h.span.class("hidden opacity-50 sm:inline").children(number),
			title,
			Option.match(activity, {
				onNone: () => h.span.key("quiet").class("size-2"),
				onSome: ({ key, isOngoing }) =>
					h.span
						.key(key)
						.attr("aria-hidden", "true")
						.class("size-2 bg-orange", isOngoing ? "blink" : "pop"),
			}),
		);

const Tabs = (h: H, model: Model): Node => {
	const isOrderRunning = model.orders.some(
		(order) => order.isKnown && !isDone(order.steps),
	);
	return h.nav
		.attr("aria-label", "Demos")
		.class("flex items-center gap-1 md:col-start-2")
		.children(
			Tab(h, {
				href: orderPath,
				number: "01",
				title: "Order",
				isActive: model.route._tag === "Order",
				activity: isOrderRunning
					? Option.some({ key: "running", isOngoing: true })
					: Option.none(),
			}),
			Tab(h, {
				href: counterPath,
				number: "02",
				title: "Counter",
				isActive: model.route._tag === "Counter",
				activity: Option.map(model.counter.maybeLastChange, ({ count }) => ({
					key: `changed-${count}`,
					isOngoing: false,
				})),
			}),
		);
};

const TopBar = (h: H, model: Model): Node =>
	h.header
		.class("topbar")
		.children(
			h.p.class("hidden truncate text-paper md:block").children(TITLE),
			Tabs(h, model),
			h.div
				.class("flex items-center justify-end gap-4 sm:gap-5 md:col-start-3")
				.children(
					h.a
						.attrs({ href: SOURCE_URL, target: "_blank", rel: "noreferrer" })
						.class("hidden lg:block", barLinkClass)
						.children("GitHub"),
					h.button
						.id("sound")
						.attrs({ type: "button", "aria-pressed": String(model.isSoundOn) })
						.on("click", Message.ClickedSound())
						.class("uppercase", barLinkClass)
						.children(model.isSoundOn ? "Sound on" : "Sound off"),
					h.div
						.class("flex items-center gap-2")
						.children(
							h.span
								.attr("aria-hidden", "true")
								.class("size-2", connectionDotClass(model.connection)),
							h.span
								.id("connection")
								.attr("aria-live", "polite")
								.class("hidden sm:inline")
								.children(connectionLabel(model.connection)),
						),
				),
		);

/** `#error` always exists, so tests can read it. It is hidden when empty. */
const ErrorBanner = (h: H, maybeError: Option.Option<string>): Node =>
	h.section
		.attr("role", "status")
		.class(Option.isSome(maybeError) ? "error fade-in" : "hidden")
		.children(
			h.span.class("shrink-0").children("Error"),
			h.p
				.id("error")
				.class("min-w-0 break-words normal-case")
				.children(Option.getOrElse(maybeError, () => "")),
		);

const NotFound = (h: H, path: string): Node =>
	h.div
		.class("slide gap-4 uppercase")
		.children(
			h.p.class("text-ink/55").children(`No page at /${path}`),
			h.a
				.attr("href", orderPath)
				.on("click", Message.ClickedTab())
				.class("text-orange-text", focusClass)
				.children("Open the Order demo →"),
		);

export const view = AppDef.view((h, model) =>
	h.div
		.class("page", model.isReloading && "power-off")
		.children(
			TopBar(h, model),
			ErrorBanner(h, model.maybeError),
			h.main
				.class("stage")
				.children(
					// A new element for each demo, so the open one draws in.
					h.div
						.key(model.route._tag)
						.class("rise-in flex w-full justify-center")
						.children(
							AppRoute.match(model.route, {
								Order: () =>
									OrderSlide(
										h,
										model,
										model.feed.filter(({ name }) => name === "StatusChanged"),
									),
								Counter: () =>
									CounterSlide(
										h,
										model.counter,
										model.feed.filter(({ name }) => name === "CountChanged"),
									),
								NotFound: ({ params }) => NotFound(h, params["*"]),
							}),
						),
				),
		),
);
