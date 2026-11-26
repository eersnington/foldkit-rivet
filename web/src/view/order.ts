import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { OrderStep } from "../../../shared/api.ts";
import { Message } from "../message.ts";
import {
	type FeedEvent,
	followedOrder,
	isStopped,
	type Model,
	type OrderRun,
} from "../model.ts";
import {
	lineNumberOf,
	ORDER_CODE,
	type SleepLine,
	type StepLine,
	WORKFLOW,
} from "../source.ts";
import {
	currentIndex,
	currentSleep,
	finishedAt,
	isDone,
	lineState,
	startOffsetMs,
} from "../workflow.ts";
import {
	type Bar,
	codeCardView,
	feedView,
	type LineMark,
	PLAIN_BLOCK,
	sourceLinkOf,
} from "./code.ts";
import {
	captionView,
	codeWord,
	focusClass,
	formatSeconds,
	kickerView,
	primaryClass,
} from "./shared.ts";

/** The line of `finish` that sends `StatusChanged` to the connected clients. */
const BROADCAST_LINE = lineNumberOf(
	ORDER_CODE,
	"events.broadcast(StatusChanged",
);

/** Only the broadcast ends in a value. The times of the steps are beside the code. */
const NOTE_LINES: ReadonlySet<number> = new Set([BROADCAST_LINE]);

/** `data-step` and `data-done` on each step line, for tests. */
const lineDataOf = (steps: ReadonlyArray<OrderStep>) =>
	new Map(
		WORKFLOW.flatMap((line) =>
			line.kind === "step"
				? [
						[
							line.lineNumber,
							{
								step: line.status,
								done: String(finishedAt(steps, line.status) !== undefined),
							},
						] as const,
					]
				: [],
		),
	);

/** The progress of a sleep, as a CSS animation that starts where the sleep is now. */
const sleepTiming = (run: OrderRun, sleep: SleepLine) => ({
	"animation-duration": `${sleep.durationMs}ms`,
	"animation-delay": `-${run.sleptMs}ms`,
});

/** When the first step finished, in Unix ms. Later steps show the time since then. */
const startedAt = (steps: ReadonlyArray<OrderStep>) =>
	Math.min(...steps.map((step) => step.at));

/** How long a finished sleep took: from the step before it to the step after it. */
const sleptFor = (steps: ReadonlyArray<OrderStep>, index: number) => {
	const before = WORKFLOW[index - 1];
	const after = WORKFLOW[index + 1];
	if (before?.kind !== "step" || after?.kind !== "step") return undefined;
	const start = finishedAt(steps, before.status);
	const end = finishedAt(steps, after.status);
	return start === undefined || end === undefined ? undefined : end - start;
};

/** Something that happened to the run during a sleep, at `fraction` of the sleep. */
type Moment = {
	readonly kind: "reloaded" | "stopped";
	readonly fraction: number;
};

const MOMENT_TITLE: Record<Moment["kind"], string> = {
	reloaded: "The page reloaded here",
	stopped: "The actor stopped here",
};

const MOMENT_SIGN: Record<Moment["kind"], string> = {
	reloaded: "↻",
	stopped: "↯",
};

/** Where `atMs`, in ms from the start of the run, falls in a sleep, from 0 to 1. */
const fractionIn = (atMs: number, sleep: SleepLine, index: number) => {
	const fraction = (atMs - startOffsetMs(index)) / sleep.durationMs;
	return fraction >= 0 && fraction <= 1 ? Option.some(fraction) : Option.none();
};

/** The page reloaded, or the visitor stopped the actor, during this sleep. */
const momentsIn = (
	run: OrderRun,
	sleep: SleepLine,
	index: number,
): ReadonlyArray<Moment> => [
	...Option.toArray(
		Option.map(
			Option.flatMap(run.maybeJoinedAtMs, (atMs) =>
				fractionIn(atMs, sleep, index),
			),
			(fraction): Moment => ({ kind: "reloaded", fraction }),
		),
	),
	...Option.toArray(
		Option.map(
			Option.flatMap(run.maybeStop, ({ atMs }) =>
				fractionIn(atMs, sleep, index),
			),
			(fraction): Moment => ({ kind: "stopped", fraction }),
		),
	),
];

/** A tick on a sleep's bar where a moment happened. `className` is the bar's mark class. */
const momentView = (
	moment: Moment,
	className: "joined" | "tl-joined",
	h: HtmlBuilder<Message>,
): Html =>
	h.span(
		[
			...(className === "joined"
				? [
						h.DataAttribute(
							"badge",
							moment.kind === "reloaded" ? "resumed" : "stopped",
						),
					]
				: []),
			h.Title(MOMENT_TITLE[moment.kind]),
			h.Class(`${className} ${className}-${moment.kind}`),
			h.Style({ left: `${moment.fraction * 100}%` }),
		],
		[],
	);

/** The run's latest step, if an event brought it while the page watched. */
const liveStep = (run: OrderRun): Option.Option<OrderStep> =>
	run.latestFrom === "event"
		? Option.fromNullishOr(run.steps.at(-1))
		: Option.none();

/** The seconds left of a sleep, counted by CSS from the same clock as its fill. */
const countdownView = (
	run: OrderRun,
	sleep: SleepLine,
	h: HtmlBuilder<Message>,
): Html =>
	h.span(
		[
			h.Class("countdown"),
			h.Style({
				...sleepTiming(run, sleep),
				"--from": `${Math.round(sleep.durationMs / 100)}`,
			}),
		],
		[],
	);

// MARKS ON THE CODE

/** A flash behind a line that just ran. `delay` matches when the bar gets there. */
const flashView = (
	key: string,
	delay: "via" | "call",
	h: HtmlBuilder<Message>,
): Html =>
	h.keyed("span")(
		key,
		[h.AriaHidden(true), h.Class(`under flash flash-${delay}`)],
		[],
	);

const stepMark = (
	run: OrderRun,
	step: StepLine,
	h: HtmlBuilder<Message>,
): LineMark => {
	const isLive = Option.exists(
		liveStep(run),
		({ status }) => status === step.status,
	);
	return {
		isDone: true,
		under: isLive
			? [flashView(`flash-${run.key}-${step.status}`, "via", h)]
			: [],
		maybeNote: Option.none(),
	};
};

/** The sleep the workflow is in fills with dither in real time. */
const sleepingMark = (
	run: OrderRun,
	sleep: SleepLine,
	index: number,
	h: HtmlBuilder<Message>,
): LineMark => {
	const timing = h.Style(sleepTiming(run, sleep));
	// After a live step the fill shows once the bar has arrived on the line.
	const arrival = Option.isSome(liveStep(run)) ? "arrive-late" : "";
	return {
		isDone: false,
		under: [
			h.keyed("span")(
				`sleep-${run.key}-${index}`,
				[h.AriaHidden(true), h.Class(`under ${arrival}`)],
				[
					h.span(
						[h.Class("sleep-track")],
						[h.span([h.Class("sleep-fill"), timing], [])],
					),
					...momentsIn(run, sleep, index).map((moment) =>
						momentView(moment, "joined", h),
					),
				],
			),
		],
		maybeNote: Option.none(),
	};
};

const sleptMark = (
	run: OrderRun,
	sleep: SleepLine,
	index: number,
	h: HtmlBuilder<Message>,
): LineMark => ({
	isDone: true,
	under: [
		h.span(
			[h.AriaHidden(true), h.Class("under")],
			[
				h.span([h.Class("slept-fill")], []),
				...momentsIn(run, sleep, index).map((moment) =>
					momentView(moment, "joined", h),
				),
			],
		),
	],
	maybeNote: Option.none(),
});

/** The event the latest live step sent, at the end of the broadcast line. */
const broadcastMark = (
	run: OrderRun,
	h: HtmlBuilder<Message>,
): Option.Option<LineMark> =>
	Option.map(liveStep(run), ({ status }) => ({
		isDone: false,
		under: [flashView(`broadcast-${run.key}-${status}`, "call", h)],
		maybeNote: Option.some(
			h.keyed("span")(
				`sent-${run.key}-${status}`,
				[h.Class("text-orange-text appear-call")],
				[`→ "${status}"`],
			),
		),
	}));

const marksOf = (
	run: OrderRun,
	h: HtmlBuilder<Message>,
): ReadonlyMap<number, LineMark> => {
	const current = currentIndex(run.steps);
	const workflowMarks = WORKFLOW.flatMap((line, index) => {
		const state = lineState(index, current);
		if (line.kind === "step") {
			return state === "done"
				? [[line.lineNumber, stepMark(run, line, h)] as const]
				: [];
		}
		switch (state) {
			case "current":
				return [[line.lineNumber, sleepingMark(run, line, index, h)] as const];
			case "done":
				return [[line.lineNumber, sleptMark(run, line, index, h)] as const];
			case "pending":
				return [];
		}
	});
	return new Map([
		...workflowMarks,
		...Option.toArray(
			Option.map(
				broadcastMark(run, h),
				(mark) => [BROADCAST_LINE, mark] as const,
			),
		),
	]);
};

/**
 * The bar follows the run. After a live step it walks the path the code took:
 * the step, the broadcast in `finish`, then the next line of the workflow.
 */
const barOf = (run: OrderRun): Option.Option<Bar> => {
	const current = currentIndex(run.steps);
	const lineNumber = (index: number) => WORKFLOW[index].lineNumber;
	const key = `${run.key}-${current}-${run.latestFrom}`;
	const isDoneNow = current === WORKFLOW.length;

	if (Option.isNone(liveStep(run))) {
		if (isDoneNow) return Option.none();
		const line = lineNumber(current);
		return Option.some({
			key,
			motion: "rest",
			from: line,
			via: line,
			call: line,
			to: line,
		});
	}

	const step = current - 1;
	return Option.some({
		key,
		motion: isDoneNow ? "last-step" : "step",
		from: lineNumber(Math.max(0, step - 1)),
		via: lineNumber(step),
		call: BROADCAST_LINE,
		to: isDoneNow ? BROADCAST_LINE : lineNumber(current),
	});
};

/** While the workflow sleeps, the sleep and the step that led to it stay dark. */
const focusOf = (run: OrderRun): Option.Option<ReadonlySet<number>> =>
	Option.map(Option.fromNullishOr(currentSleep(run.steps)), (sleep) => {
		const current = currentIndex(run.steps);
		const lines = [sleep.lineNumber, WORKFLOW[current - 1].lineNumber];
		return new Set(
			Option.isSome(liveStep(run)) ? [...lines, BROADCAST_LINE] : lines,
		);
	});

// THE TIMELINE BESIDE THE CODE

/** A step's name as a word: `"charge"` reads as Charge. */
const stepWord = (step: StepLine) =>
	step.name.charAt(0).toUpperCase() + step.name.slice(1);

/**
 * A step as a row: a box that fills when it is done, its name, and when it
 * finished, in seconds since the first step.
 */
const stepRowView = (
	steps: ReadonlyArray<OrderStep>,
	step: StepLine,
	h: HtmlBuilder<Message>,
): Html => {
	const at = finishedAt(steps, step.status);
	const isDone = at !== undefined;
	return h.li(
		[h.Class(`tl-row tl-step ${isDone ? "" : "tl-pending"}`)],
		[
			h.keyed("span")(
				isDone ? "done" : "open",
				[
					h.AriaHidden(true),
					h.Class(`tl-box ${isDone ? "tl-box-done pop" : ""}`),
				],
				[],
			),
			h.span([h.Class("tl-name")], [stepWord(step)]),
			h.span([h.AriaHidden(true), h.Class("tl-leader")], []),
			h.span(
				[h.Class("tl-value")],
				[isDone ? formatSeconds(at - startedAt(steps)) : "–"],
			),
		],
	);
};

/**
 * A sleep as a thin bar between two steps. The sleep running now fills in
 * orange in real time and counts down. A finished one shows how long it
 * really took, and a mark if the page reloaded during it.
 */
const sleepRowView = (
	maybeRun: Option.Option<OrderRun>,
	sleep: SleepLine,
	index: number,
	h: HtmlBuilder<Message>,
): Html => {
	const state = Option.match(maybeRun, {
		onNone: () => "pending" as const,
		onSome: (run) => lineState(index, currentIndex(run.steps)),
	});
	const moments = Option.match(maybeRun, {
		onNone: () => [],
		onSome: (run) => momentsIn(run, sleep, index),
	});
	const fill = Option.match(maybeRun, {
		onNone: () => [],
		onSome: (run) => {
			switch (state) {
				case "current":
					return [
						h.keyed("span")(
							`fill-${run.key}-${index}`,
							[h.Class("tl-fill"), h.Style(sleepTiming(run, sleep))],
							[],
						),
					];
				case "done":
					return [h.span([h.Class("tl-fill tl-fill-done")], [])];
				case "pending":
					return [];
			}
		},
	});
	const value = Option.match(maybeRun, {
		onNone: () => "",
		onSome: (run) => {
			switch (state) {
				case "current":
					return h.span([], [countdownView(run, sleep, h), " left"]);
				case "done": {
					const signs = moments.map(({ kind }) => `${MOMENT_SIGN[kind]} `);
					const took = sleptFor(run.steps, index) ?? sleep.durationMs;
					return `${signs.join("")}${formatSeconds(took)}`;
				}
				case "pending":
					return "";
			}
		},
	});

	return h.li(
		[h.Class(`tl-row tl-sleep ${state === "current" ? "tl-live" : ""}`)],
		[
			h.span([h.Class("tl-name")], [`Sleep ${sleep.durationMs / 1000}s`]),
			h.span(
				[h.AriaHidden(true), h.Class("tl-bar")],
				[
					...fill,
					...moments.map((moment) => momentView(moment, "tl-joined", h)),
				],
			),
			h.span([h.Class("tl-value")], [value]),
		],
	);
};

const timelineView = (
	maybeRun: Option.Option<OrderRun>,
	h: HtmlBuilder<Message>,
): Html => {
	const steps = Option.match(maybeRun, {
		onNone: () => [],
		onSome: (run) => run.steps,
	});
	return h.ol(
		[h.AriaLabel("Timeline"), h.Class("timeline")],
		WORKFLOW.map((line, index) =>
			line.kind === "step"
				? stepRowView(steps, line, h)
				: sleepRowView(maybeRun, line, index, h),
		),
	);
};

/**
 * The one large number: how long the order has run. During a sleep CSS
 * counts it up from the saved steps, so a reload does not reset it.
 */
const elapsedView = (
	maybeRun: Option.Option<OrderRun>,
	h: HtmlBuilder<Message>,
): Html => {
	const big = (key: string, isLive: boolean, value: Html | string) =>
		h.keyed("p")(
			key,
			[h.Class(`elapsed-value ${isLive ? "text-orange" : ""}`)],
			[value],
		);
	const content = Option.match(maybeRun, {
		onNone: () => ({ label: "Elapsed", value: big("none", false, "0.0s") }),
		onSome: (run) => {
			if (run.steps.length === 0) {
				return { label: "Elapsed", value: big("start", false, "0.0s") };
			}
			const ranMs =
				Math.max(...run.steps.map((step) => step.at)) - startedAt(run.steps);
			if (isDone(run.steps)) {
				return {
					label: "Shipped in",
					value: big(`done-${run.key}`, false, formatSeconds(ranMs)),
				};
			}
			const sleep = currentSleep(run.steps);
			if (sleep === undefined) {
				return {
					label: "Elapsed",
					value: big("running", true, formatSeconds(ranMs)),
				};
			}
			const fromTenths = Math.round(ranMs / 100);
			return {
				label: "Elapsed",
				value: big(
					`clock-${run.key}-${sleep.lineNumber}`,
					true,
					h.span(
						[
							h.Class("elapsed-clock"),
							h.Style({
								...sleepTiming(run, sleep),
								"--from": `${fromTenths}`,
								"--to": `${fromTenths + Math.round(sleep.durationMs / 100)}`,
							}),
						],
						[],
					),
				),
			};
		},
	});
	return h.div(
		[h.Class("elapsed")],
		[h.p([h.Class("side-label")], [content.label]), content.value],
	);
};

// ACTIONS

const startButton = (label: string, h: HtmlBuilder<Message>): Html =>
	h.keyed("button")(
		`start-${label}`,
		[
			h.Id("start-order"),
			h.Type("button"),
			h.OnClick(Message.ClickedStartOrder()),
			h.Class(primaryClass),
		],
		[label, h.span([h.AriaHidden(true)], ["→"])],
	);

/** A ring that empties as the sleep runs out, on the same clock as the sleep. */
const timerView = (
	run: OrderRun,
	sleep: SleepLine,
	h: HtmlBuilder<Message>,
): Html =>
	h.svg(
		[h.AriaHidden(true), h.ViewBox("0 0 20 20"), h.Class("timer")],
		[
			h.circle([h.Class("timer-track")], []),
			h.circle([h.Class("timer-left"), h.Style(sleepTiming(run, sleep))], []),
		],
	);

/** During a sleep the next thing to do is reload, before the ring runs out. */
/**
 * During a sleep the next thing to do is stop the actor that runs the
 * workflow. The ring shows how long the sleep has left.
 */
const stopButton = (
	run: OrderRun,
	sleep: SleepLine,
	h: HtmlBuilder<Message>,
): Html =>
	h.keyed("button")(
		`stop-${run.key}-${sleep.lineNumber}-${run.wokeAt.length}`,
		[
			h.Type("button"),
			h.DataAttribute("action", "stop"),
			h.OnClick(Message.ClickedStopActor()),
			h.Class(primaryClass),
		],
		["Stop the actor", timerView(run, sleep, h)],
	);

/** While the actor is down, the page holds no connection. This opens one again. */
const reconnectButton = (h: HtmlBuilder<Message>): Html =>
	h.keyed("button")(
		"reconnect",
		[
			h.Type("button"),
			h.DataAttribute("action", "reconnect"),
			h.OnClick(Message.ClickedReconnect()),
			h.Class(primaryClass),
		],
		["Reconnect now", h.span([h.AriaHidden(true)], ["↻"])],
	);

/** A reload also rejoins the run, so it stays, as a quiet second choice. */
const reloadLink = (h: HtmlBuilder<Message>): Html =>
	h.button(
		[
			h.Type("button"),
			h.DataAttribute("action", "reload"),
			h.OnClick(Message.ClickedReload()),
			h.Class(`reload-link ${focusClass}`),
		],
		["Or reload this page"],
	);

const waitingButton = (label: string, h: HtmlBuilder<Message>): Html =>
	h.keyed("button")(
		`waiting-${label}`,
		[h.Type("button"), h.Disabled(true), h.Class(primaryClass)],
		[label, h.span([h.AriaHidden(true), h.Class("blink")], ["…"])],
	);

const actionView = (
	maybeRun: Option.Option<OrderRun>,
	h: HtmlBuilder<Message>,
): Html =>
	h.div(
		[h.Class("actions actions-stack")],
		Option.match(maybeRun, {
			onNone: () => [startButton("Start an order", h)],
			onSome: (run) => {
				const sleep = currentSleep(run.steps);
				if (run.isDisconnected) return [reconnectButton(h)];
				if (isStopped(run)) return [waitingButton("Reconnecting", h)];
				if (sleep !== undefined)
					return [stopButton(run, sleep, h), reloadLink(h)];
				if (isDone(run.steps)) return [startButton("Start another order", h)];
				return [
					waitingButton(run.isKnown ? "Running" : "Reading the order", h),
				];
			},
		}),
	);

const sideView = (
	maybeRun: Option.Option<OrderRun>,
	h: HtmlBuilder<Message>,
): Html =>
	h.aside(
		[h.Class("side")],
		[
			h.div(
				[h.Class("side-head")],
				[
					h.p(
						[h.Class("side-label flex justify-between gap-4")],
						[
							h.span([], ["Order key"]),
							// Each start of the actor counts. A stop and a start again show here.
							...Option.match(
								Option.filter(maybeRun, ({ wokeAt }) => wokeAt.length > 0),
								{
									onNone: () => [],
									onSome: ({ key, wokeAt }) => [
										h.keyed("span")(
											`wakes-${key}-${wokeAt.length}`,
											[
												h.Class(
													wokeAt.length > 1 ? "pop text-orange-text" : "",
												),
											],
											[`Actor started ${wokeAt.length}×`],
										),
									],
								},
							),
						],
					),
					Option.match(maybeRun, {
						onNone: () => h.p([h.Class("text-ink/35")], ["None yet"]),
						onSome: ({ key }) =>
							h.keyed("p")(key, [h.Class("fade-in truncate")], [key]),
					}),
				],
			),
			elapsedView(maybeRun, h),
			timelineView(maybeRun, h),
			actionView(maybeRun, h),
		],
	);

/** One line that says what happened and what to do next. */
const captionOf = (
	maybeRun: Option.Option<OrderRun>,
	h: HtmlBuilder<Message>,
): Html =>
	Option.match(maybeRun, {
		onNone: () =>
			captionView(
				"idle",
				[
					"Starts an ",
					codeWord("Order", h),
					" workflow on the server. It saves each step before it runs the next.",
				],
				h,
			),
		onSome: (run) => {
			const hasStopped = Option.isSome(run.maybeStop);
			const hasJoined = Option.isSome(run.maybeJoinedAtMs);
			if (isDone(run.steps)) {
				const ats = run.steps.map((step) => step.at);
				const took = formatSeconds(Math.max(...ats) - Math.min(...ats));
				if (hasStopped) {
					return captionView(
						`done-stopped-${run.key}`,
						[
							`Shipped in ${took}. The actor stopped mid-run and started again, and no step ran twice.`,
						],
						h,
					);
				}
				return captionView(
					`done-${run.key}`,
					[
						hasJoined
							? `Shipped in ${took}. The workflow ran on while the page reloaded.`
							: `Shipped in ${took}. Next time, stop the actor while it sleeps.`,
					],
					h,
				);
			}
			if (run.isDisconnected) {
				return captionView(
					`stopped-${run.key}`,
					[
						"The actor is stopped and this page let go of it. Nothing runs the workflow now. When the sleep ends, RivetKit wakes the actor by itself.",
					],
					h,
				);
			}
			if (currentSleep(run.steps) === undefined) {
				return captionView("running", ["The workflow is running."], h);
			}
			if (hasStopped) {
				return captionView(
					`restarted-${run.key}-${run.wokeAt.length}`,
					[
						"The actor started again. The workflow replayed its history, skipped the finished steps, and went on from the same step.",
					],
					h,
				);
			}
			if (hasJoined) {
				return captionView(
					`joined-${run.key}`,
					[
						"The page reloaded, read the saved steps with ",
						codeWord("GetStatus", h),
						", and joined the run where it was.",
					],
					h,
				);
			}
			return captionView(
				"sleeping",
				[
					"The workflow sleeps on the server. Stop its actor and watch it come back.",
				],
				h,
			);
		},
	});

/** The line over the code: what the actor is doing now. */
const subjectView = (
	maybeRun: Option.Option<OrderRun>,
	h: HtmlBuilder<Message>,
): Html =>
	Option.match(
		Option.filter(maybeRun, (run) => run.isDisconnected || isStopped(run)),
		{
			onNone: () => h.span([], ["The workflow, running"]),
			onSome: () =>
				h.span(
					[h.Class("text-orange")],
					["Actor stopped, memory gone", h.span([h.Class("blink")], [" ■"])],
				),
		},
	);

// SLIDE

export const orderSlideView = (
	model: Model,
	feed: ReadonlyArray<FeedEvent>,
	h: HtmlBuilder<Message>,
): Html => {
	const maybeRun = followedOrder(model);
	const card = codeCardView(
		{
			name: "orderCode",
			block: ORDER_CODE,
			options: Option.match(maybeRun, {
				onNone: () => ({
					...PLAIN_BLOCK,
					noteLines: NOTE_LINES,
					lineData: lineDataOf([]),
				}),
				// A stopped actor runs nothing, so no line is lit.
				onSome: (run) => {
					const isDown = run.isDisconnected || isStopped(run);
					return {
						maybeBar: isDown ? Option.none() : barOf(run),
						marks: marksOf(run, h),
						maybeFocus: isDown ? Option.some(new Set()) : focusOf(run),
						noteLines: NOTE_LINES,
						lineData: lineDataOf(run.steps),
					};
				},
			}),
			subject: subjectView(maybeRun, h),
			footer: feedView(feed, h),
		},
		h,
	);

	return h.div(
		[
			...Option.match(maybeRun, {
				onNone: () => [],
				onSome: ({ key }) => [h.DataAttribute("order", key)],
			}),
			h.Class("slide"),
		],
		[
			kickerView(
				"Durable workflow, one per order",
				sourceLinkOf(ORDER_CODE),
				h,
			),
			h.h1([h.Class("title")], ["Order workflow"]),
			h.div([h.Class("slide-body")], [card, sideView(maybeRun, h)]),
			captionOf(maybeRun, h),
		],
	);
};
