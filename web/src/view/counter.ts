import { Array, Option } from "effect";
import { BURST_SIZE, COUNTER_KEY, MAX_RECENT_CALLS } from "../constant.ts";
import { Message } from "../message.ts";
import type { CounterState, FeedEvent, IncrementResult } from "../model.ts";
import { INCREMENT, lineNumberOf } from "../source.ts";
import {
	CodeCard,
	Feed,
	type LineMark,
	PLAIN_BLOCK,
	sourceLinkOf,
} from "./code.ts";
import {
	Caption,
	CodeWord,
	type H,
	Kicker,
	type Node,
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
const Odometer = (h: H, countText: string): ReadonlyArray<Node> =>
	[...countText].map((character, index) =>
		/\d/.test(character)
			? h.span
					.key(`digit-${countText.length - index}`)
					.class("digit")
					.children(
						h.span
							.class("digit-roll")
							.style({ "--digit": character })
							.children(
								// The shadow repeats the digit from `data-digit`.
								DIGITS.map((digit) =>
									h.span.attr("data-digit", digit).children(digit),
								),
							),
					)
			: h.span.key(`text-${index}`).children(character),
	);

/** One "+1" for each of the latest presses, each in its own lane. */
const Rising = (h: H, presses: number): ReadonlyArray<Node> =>
	presses === 0
		? []
		: Array.range(Math.max(1, presses - MAX_RISING + 1), presses).map((press) =>
				h.span
					.key(`press-${press}`)
					.attr("aria-hidden", "true")
					.class("rising")
					.style({ "--lane": `${press % MAX_RISING}` })
					.children("+1"),
			);

const maybeRemoteCount = (counter: CounterState) =>
	Option.flatMap(counter.maybeLastChange, (change) =>
		change.isRemote ? Option.some(change.count) : Option.none(),
	);

const Count = (h: H, counter: CounterState): Node => {
	const countText = Option.match(counter.maybeCount, {
		onNone: () => "…",
		onSome: (count) => count.toString(),
	});
	return h.div.class("flex flex-col gap-2").children(
		// Tests and screen readers read the number here. The digits that roll are beside it.
		h.span
			.id("count")
			.attr("aria-live", "polite")
			.class("sr-only")
			.children(countText),
		h.span
			.attr("aria-hidden", "true")
			.class("count")
			.children(
				Option.match(maybeRemoteCount(counter), {
					onNone: () => null,
					onSome: (count) => h.span.key(`flash-${count}`).class("remote-flash"),
				}),
				Odometer(h, countText),
				Rising(h, counter.presses),
			),
		h.p.class("uppercase tracking-[0.04em]").children(
			Option.match(maybeRemoteCount(counter), {
				onNone: () =>
					h.span
						.key("shared")
						.class("text-ink/55")
						.children("The count, shared by every window"),
				onSome: (count) =>
					h.span
						.key(`remote-${count}`)
						.class("pop text-orange-text")
						.children(
							"Changed by ",
							h.span.id("count-source").children("another window"),
						),
			}),
		),
	);
};

/** The time of each recent call as a bar, and the count it got back under it. */
const Chart = (h: H, counter: CounterState): Node => {
	const calls = counter.recentCalls;
	const slowestMs = Math.max(1, ...calls.map(({ tookMs }) => tookMs));
	const slots = { "--slots": `${MAX_RECENT_CALLS}` };
	const Bar = (call: IncrementResult, index: number) =>
		h.div
			.key(`bar-${call.count}`)
			.class("chart-bar", index === calls.length - 1 && "chart-bar-latest")
			.style({ "--height": `${(call.tookMs / slowestMs) * 100}%` })
			.attr("title", `${call.count} in ${call.tookMs} ms`)
			.children(h.span.class("chart-bar-ms").children(`${call.tookMs}`));

	return h.figure
		.attr(
			"data-burst",
			Option.match(counter.maybeBurst, {
				onNone: () => undefined,
				onSome: ({ id }) => String(id),
			}),
		)
		.class("chart")
		.children(
			h.figcaption
				.class("flex justify-between gap-4")
				.children(
					h.span.children("Call time, ms"),
					h.span.class("text-ink/55").children(`Last ${MAX_RECENT_CALLS} calls`),
				),
			h.div
				.class("chart-bars")
				.style(slots)
				.children(
					calls.length === 0
						? h.p
								.class("col-span-full self-center text-center text-ink/35")
								.children("No calls yet")
						: calls.map(Bar),
				),
			h.div
				.attr("aria-hidden", "true")
				.class("chart-counts")
				.style(slots)
				.children(
					calls.map((call) =>
						h.span.key(`count-${call.count}`).children(`${call.count}`),
					),
				),
		);
};

const marksOf = (h: H, counter: CounterState): ReadonlyMap<number, LineMark> => {
	const flash = (key: string) =>
		h.span.key(key).attr("aria-hidden", "true").class("under flash");
	const returned = Option.map(
		Option.fromNullishOr(counter.recentCalls.at(-1)),
		({ count }): LineMark => ({
			isDone: false,
			under: [flash(`return-${count}`)],
			maybeNote: Option.some(
				h.span.key(`return-${count}`).class("fade-in").children(`→ ${count}`),
			),
		}),
	);
	const broadcast = Option.map(
		counter.maybeLastChange,
		({ count, isRemote }): LineMark => ({
			isDone: false,
			under: [flash(`broadcast-${count}`)],
			maybeNote: Option.some(
				h.span
					.key(`broadcast-${count}`)
					.class("fade-in", isRemote && "text-orange-text")
					.children(`→ ${count}`),
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

const CounterCaption = (h: H, counter: CounterState): Node => {
	if (Option.isSome(maybeRemoteCount(counter))) {
		return Caption(h, "remote", [
			"Another window called ",
			CodeWord(h, "Increment"),
			". The ",
			CodeWord(h, "CountChanged"),
			" event brought the new count here.",
		]);
	}
	return Option.match(counter.maybeBurst, {
		onNone: () =>
			Caption(h, "idle", [
				"One ",
				CodeWord(h, "Counter"),
				" actor keeps the count in SQLite. Open a second window and watch both.",
			]),
		onSome: (burst) => {
			if (burst.results.length < BURST_SIZE) {
				return Caption(h, `burst-${burst.id}`, [
					`${BURST_SIZE} calls to `,
					CodeWord(h, "Increment"),
					" are in flight.",
				]);
			}
			const distinct = new Set(burst.results.map(({ count }) => count)).size;
			return Caption(
				h,
				`burst-done-${burst.id}`,
				distinct === BURST_SIZE
					? [
							`${BURST_SIZE} calls at once got ${BURST_SIZE} different counts. Each `,
							CodeWord(h, "UPDATE … RETURNING"),
							" is atomic.",
						]
					: [`${BURST_SIZE} calls at once got ${distinct} different counts.`],
			);
		},
	});
};

const Actions = (h: H): Node =>
	h.div
		.class("actions grid grid-cols-1 sm:grid-cols-2")
		.children(
			h.button
				.id("increment")
				.attr("type", "button")
				.on("click", Message.ClickedIncrement())
				.class(primaryClass, "sm:col-span-2")
				.children("Increment", h.span.attr("aria-hidden", "true").children("+1")),
			h.button
				.id("burst")
				.attr("type", "button")
				.on("click", Message.ClickedBurst())
				.class(secondaryClass)
				.children(`× ${BURST_SIZE} at once`),
			h.button
				.id("open-client")
				.attr("type", "button")
				.on("click", Message.ClickedOpenClient())
				.class(secondaryClass)
				.children(
					"Second window",
					h.span.attr("aria-hidden", "true").children("↗"),
				),
		);

export const CounterSlide = (
	h: H,
	counter: CounterState,
	feed: ReadonlyArray<FeedEvent>,
): Node =>
	h.div
		.class("slide slide-counter")
		.children(
			Kicker(h, "One actor, one SQLite row, every window", sourceLinkOf(INCREMENT)),
			h.h1.class("title").children("Shared counter"),
			h.div
				.class("slide-body")
				.children(
					h.div
						.class("flex flex-col gap-7")
						.children(Count(h, counter), Chart(h, counter), Actions(h)),
					CodeCard(h, {
						name: "increment",
						block: INCREMENT,
						options: {
							...PLAIN_BLOCK,
							marks: marksOf(h, counter),
							noteLines: NOTE_LINES,
						},
						subject: h.span.children(`Counter "${COUNTER_KEY}", Increment`),
						footer: Feed(h, feed),
					}),
				),
			CounterCaption(h, counter),
		);
