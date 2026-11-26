import { Array, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { BURST_SIZE, COUNTER_KEY, MAX_RECENT_CALLS } from "../constant.ts";
import { Message } from "../message.ts";
import type { CounterState, FeedEvent, IncrementResult } from "../model.ts";
import { INCREMENT, lineNumberOf } from "../source.ts";
import {
	codeCardView,
	feedView,
	type LineMark,
	PLAIN_BLOCK,
	sourceLinkOf,
} from "./code.ts";
import {
	captionView,
	codeWord,
	kickerView,
	primaryClass,
	secondaryClass,
} from "./shared.ts";

/** The line that returns the new count to the caller. */
const RETURN_LINE = lineNumberOf(
	INCREMENT,
	"Effect.map(([{ count }]) => count)",
);

/** The line that sends `CountChanged` to every connected client. */
const BROADCAST_LINE = lineNumberOf(INCREMENT, "events.broadcast(CountChanged");

const NOTE_LINES: ReadonlySet<number> = new Set([RETURN_LINE, BROADCAST_LINE]);

/** How many "+1" marks can rise at once. Older ones have faded by then. */
const MAX_RISING = 3;

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * The count, as a column of 0 to 9 for each digit that rolls to its place.
 * The key counts from the right, so a column keeps its place as the count grows.
 */
const odometerView = (
	countText: string,
	h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
	[...countText].map((character, index) =>
		/\d/.test(character)
			? h.keyed("span")(
					`digit-${countText.length - index}`,
					[h.Class("digit")],
					[
						h.span(
							[h.Class("digit-roll"), h.Style({ "--digit": character })],
							// The shadow repeats the digit from `data-digit`.
							DIGITS.map((digit) =>
								h.span([h.DataAttribute("digit", digit)], [digit]),
							),
						),
					],
				)
			: h.keyed("span")(`text-${index}`, [], [character]),
	);

/** One "+1" for each of the latest presses, each in its own lane. */
const risingView = (
	presses: number,
	h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
	presses === 0
		? []
		: Array.range(Math.max(1, presses - MAX_RISING + 1), presses).map((press) =>
				h.keyed("span")(
					`press-${press}`,
					[
						h.AriaHidden(true),
						h.Class("rising"),
						h.Style({ "--lane": `${press % MAX_RISING}` }),
					],
					["+1"],
				),
			);

const maybeRemoteCount = (counter: CounterState) =>
	Option.flatMap(counter.maybeLastChange, (change) =>
		change.isRemote ? Option.some(change.count) : Option.none(),
	);

const countView = (counter: CounterState, h: HtmlBuilder<Message>): Html => {
	const countText = Option.match(counter.maybeCount, {
		onNone: () => "…",
		onSome: (count) => count.toString(),
	});
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			// Tests and screen readers read the number here. The digits that roll are beside it.
			h.span(
				[h.Id("count"), h.AriaLive("polite"), h.Class("sr-only")],
				[countText],
			),
			h.span(
				[h.AriaHidden(true), h.Class("count")],
				[
					...Option.match(maybeRemoteCount(counter), {
						onNone: () => [],
						onSome: (count) => [
							h.keyed("span")(`flash-${count}`, [h.Class("remote-flash")], []),
						],
					}),
					...odometerView(countText, h),
					...risingView(counter.presses, h),
				],
			),
			h.p(
				[h.Class("uppercase tracking-[0.04em]")],
				[
					Option.match(maybeRemoteCount(counter), {
						onNone: () =>
							h.keyed("span")(
								"shared",
								[h.Class("text-ink/55")],
								["The count, shared by every window"],
							),
						onSome: (count) =>
							h.keyed("span")(
								`remote-${count}`,
								[h.Class("pop text-orange-text")],
								[
									"Changed by ",
									h.span([h.Id("count-source")], ["another window"]),
								],
							),
					}),
				],
			),
		],
	);
};

/** The time of each recent call as a bar, and the count it got back under it. */
const chartView = (counter: CounterState, h: HtmlBuilder<Message>): Html => {
	const calls = counter.recentCalls;
	const slowestMs = Math.max(1, ...calls.map(({ tookMs }) => tookMs));
	const slots = { "--slots": `${MAX_RECENT_CALLS}` };
	const barView = (call: IncrementResult, index: number) =>
		h.keyed("div")(
			`bar-${call.count}`,
			[
				h.Class(
					`chart-bar ${index === calls.length - 1 ? "chart-bar-latest" : ""}`,
				),
				h.Style({ "--height": `${(call.tookMs / slowestMs) * 100}%` }),
				h.Title(`${call.count} in ${call.tookMs} ms`),
			],
			[h.span([h.Class("chart-bar-ms")], [`${call.tookMs}`])],
		);

	return h.figure(
		[
			...Option.match(counter.maybeBurst, {
				onNone: () => [],
				onSome: ({ id }) => [h.DataAttribute("burst", String(id))],
			}),
			h.Class("chart"),
		],
		[
			h.figcaption(
				[h.Class("flex justify-between gap-4")],
				[
					h.span([], ["Call time, ms"]),
					h.span([h.Class("text-ink/55")], [`Last ${MAX_RECENT_CALLS} calls`]),
				],
			),
			h.div(
				[h.Class("chart-bars"), h.Style(slots)],
				calls.length === 0
					? [
							h.p(
								[h.Class("col-span-full self-center text-center text-ink/35")],
								["No calls yet"],
							),
						]
					: calls.map(barView),
			),
			h.div(
				[h.AriaHidden(true), h.Class("chart-counts"), h.Style(slots)],
				calls.map((call) =>
					h.keyed("span")(`count-${call.count}`, [], [`${call.count}`]),
				),
			),
		],
	);
};

const marksOf = (
	counter: CounterState,
	h: HtmlBuilder<Message>,
): ReadonlyMap<number, LineMark> => {
	const flash = (key: string) =>
		h.keyed("span")(key, [h.AriaHidden(true), h.Class("under flash")], []);
	const returned = Option.map(
		Option.fromNullishOr(counter.recentCalls.at(-1)),
		({ count }): LineMark => ({
			isDone: false,
			under: [flash(`return-${count}`)],
			maybeNote: Option.some(
				h.keyed("span")(
					`return-${count}`,
					[h.Class("fade-in")],
					[`→ ${count}`],
				),
			),
		}),
	);
	const broadcast = Option.map(
		counter.maybeLastChange,
		({ count, isRemote }): LineMark => ({
			isDone: false,
			under: [flash(`broadcast-${count}`)],
			maybeNote: Option.some(
				h.keyed("span")(
					`broadcast-${count}`,
					[h.Class(`fade-in ${isRemote ? "text-orange-text" : ""}`)],
					[`→ ${count}`],
				),
			),
		}),
	);
	return new Map([
		...Option.toArray(
			Option.map(returned, (mark) => [RETURN_LINE, mark] as const),
		),
		...Option.toArray(
			Option.map(broadcast, (mark) => [BROADCAST_LINE, mark] as const),
		),
	]);
};

const captionOf = (counter: CounterState, h: HtmlBuilder<Message>): Html => {
	if (Option.isSome(maybeRemoteCount(counter))) {
		return captionView(
			"remote",
			[
				"Another window called ",
				codeWord("Increment", h),
				". The ",
				codeWord("CountChanged", h),
				" event brought the new count here.",
			],
			h,
		);
	}
	return Option.match(counter.maybeBurst, {
		onNone: () =>
			captionView(
				"idle",
				[
					"One ",
					codeWord("Counter", h),
					" actor keeps the count in SQLite. Open a second window and watch both.",
				],
				h,
			),
		onSome: (burst) => {
			if (burst.results.length < BURST_SIZE) {
				return captionView(
					`burst-${burst.id}`,
					[
						`${BURST_SIZE} calls to `,
						codeWord("Increment", h),
						" are in flight.",
					],
					h,
				);
			}
			const distinct = new Set(burst.results.map(({ count }) => count)).size;
			return captionView(
				`burst-done-${burst.id}`,
				distinct === BURST_SIZE
					? [
							`${BURST_SIZE} calls at once got ${BURST_SIZE} different counts. Each `,
							codeWord("UPDATE … RETURNING", h),
							" is atomic.",
						]
					: [`${BURST_SIZE} calls at once got ${distinct} different counts.`],
				h,
			);
		},
	});
};

const actionsView = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("actions grid grid-cols-1 sm:grid-cols-2")],
		[
			h.button(
				[
					h.Id("increment"),
					h.Type("button"),
					h.OnClick(Message.ClickedIncrement()),
					h.Class(`${primaryClass} sm:col-span-2`),
				],
				["Increment", h.span([h.AriaHidden(true)], ["+1"])],
			),
			h.button(
				[
					h.Id("burst"),
					h.Type("button"),
					h.OnClick(Message.ClickedBurst()),
					h.Class(secondaryClass),
				],
				[`× ${BURST_SIZE} at once`],
			),
			h.button(
				[
					h.Id("open-client"),
					h.Type("button"),
					h.OnClick(Message.ClickedOpenClient()),
					h.Class(secondaryClass),
				],
				["Second window", h.span([h.AriaHidden(true)], ["↗"])],
			),
		],
	);

export const counterSlideView = (
	counter: CounterState,
	feed: ReadonlyArray<FeedEvent>,
	h: HtmlBuilder<Message>,
): Html =>
	h.div(
		[h.Class("slide slide-counter")],
		[
			kickerView(
				"One actor, one SQLite row, every window",
				sourceLinkOf(INCREMENT),
				h,
			),
			h.h1([h.Class("title")], ["Shared counter"]),
			h.div(
				[h.Class("slide-body")],
				[
					h.div(
						[h.Class("flex flex-col gap-7")],
						[countView(counter, h), chartView(counter, h), actionsView(h)],
					),
					codeCardView(
						{
							name: "increment",
							block: INCREMENT,
							options: {
								...PLAIN_BLOCK,
								marks: marksOf(counter, h),
								noteLines: NOTE_LINES,
							},
							subject: h.span([], [`Counter "${COUNTER_KEY}", Increment`]),
							footer: feedView(feed, h),
						},
						h,
					),
				],
			),
			captionOf(counter, h),
		],
	);
