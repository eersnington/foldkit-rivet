import { Option } from "effect";
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
	CodeCard,
	Feed,
	type LineMark,
	PLAIN_BLOCK,
	sourceLinkOf,
} from "./code.ts";
import {
	Caption,
	CodeWord,
	focusClass,
	formatSeconds,
	type H,
	Kicker,
	type Node,
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
	animationDuration: `${sleep.durationMs}ms`,
	animationDelay: `-${run.sleptMs}ms`,
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
const MomentTick = (
	h: H,
	moment: Moment,
	className: "joined" | "tl-joined",
): Node =>
	h.span
		.attr(
			"data-badge",
			className === "joined"
				? moment.kind === "reloaded"
					? "resumed"
					: "stopped"
				: undefined,
		)
		.attr("title", MOMENT_TITLE[moment.kind])
		.class(className, `${className}-${moment.kind}`)
		.style({ left: `${moment.fraction * 100}%` });

/** The run's latest step, if an event brought it while the page watched. */
const liveStep = (run: OrderRun): Option.Option<OrderStep> =>
	run.latestFrom === "event"
		? Option.fromNullishOr(run.steps.at(-1))
		: Option.none();

/** The seconds left of a sleep, counted by CSS from the same clock as its fill. */
const Countdown = (h: H, run: OrderRun, sleep: SleepLine): Node =>
	h.span.class("countdown").style({
		...sleepTiming(run, sleep),
		"--from": `${Math.round(sleep.durationMs / 100)}`,
	});

// MARKS ON THE CODE

/** A flash behind a line that just ran. `delay` matches when the bar gets there. */
const Flash = (h: H, key: string, delay: "via" | "call"): Node =>
	h.span
		.key(key)
		.attr("aria-hidden", "true")
		.class("under flash", `flash-${delay}`);

const stepMark = (h: H, run: OrderRun, step: StepLine): LineMark => {
	const isLive = Option.exists(
		liveStep(run),
		({ status }) => status === step.status,
	);
	return {
		isDone: true,
		under: isLive ? [Flash(h, `flash-${run.key}-${step.status}`, "via")] : [],
		maybeNote: Option.none(),
	};
};

/** The sleep the workflow is in fills with dither in real time. */
const sleepingMark = (
	h: H,
	run: OrderRun,
	sleep: SleepLine,
	index: number,
): LineMark => ({
	isDone: false,
	under: [
		h.span
			.key(`sleep-${run.key}-${index}`)
			.attr("aria-hidden", "true")
			// After a live step the fill shows once the bar has arrived on the line.
			.class("under", Option.isSome(liveStep(run)) && "arrive-late")
			.children(
				h.span
					.class("sleep-track")
					.children(h.span.class("sleep-fill").style(sleepTiming(run, sleep))),
				momentsIn(run, sleep, index).map((moment) =>
					MomentTick(h, moment, "joined"),
				),
			),
	],
	maybeNote: Option.none(),
});

const sleptMark = (
	h: H,
	run: OrderRun,
	sleep: SleepLine,
	index: number,
): LineMark => ({
	isDone: true,
	under: [
		h.span
			.attr("aria-hidden", "true")
			.class("under")
			.children(
				h.span.class("slept-fill"),
				momentsIn(run, sleep, index).map((moment) =>
					MomentTick(h, moment, "joined"),
				),
			),
	],
	maybeNote: Option.none(),
});

/** The event the latest live step sent, at the end of the broadcast line. */
const broadcastMark = (h: H, run: OrderRun): Option.Option<LineMark> =>
	Option.map(liveStep(run), ({ status }) => ({
		isDone: false,
		under: [Flash(h, `broadcast-${run.key}-${status}`, "call")],
		maybeNote: Option.some(
			h.span
				.key(`sent-${run.key}-${status}`)
				.class("text-orange-text appear-call")
				.children(`→ "${status}"`),
		),
	}));

const marksOf = (h: H, run: OrderRun): ReadonlyMap<number, LineMark> => {
	const current = currentIndex(run.steps);
	const workflowMarks = WORKFLOW.flatMap((line, index) => {
		const state = lineState(index, current);
		if (line.kind === "step") {
			return state === "done"
				? [[line.lineNumber, stepMark(h, run, line)] as const]
				: [];
		}
		switch (state) {
			case "current":
				return [[line.lineNumber, sleepingMark(h, run, line, index)] as const];
			case "done":
				return [[line.lineNumber, sleptMark(h, run, line, index)] as const];
			case "pending":
				return [];
		}
	});
	return new Map([
		...workflowMarks,
		...Option.toArray(
			Option.map(broadcastMark(h, run), (mark) => [BROADCAST_LINE, mark] as const),
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
const StepRow = (
	h: H,
	steps: ReadonlyArray<OrderStep>,
	step: StepLine,
): Node => {
	const at = finishedAt(steps, step.status);
	const isDone = at !== undefined;
	return h.li
		.class("tl-row tl-step", !isDone && "tl-pending")
		.children(
			h.span
				.key(isDone ? "done" : "open")
				.attr("aria-hidden", "true")
				.class("tl-box", isDone && "tl-box-done pop"),
			h.span.class("tl-name").children(stepWord(step)),
			h.span.attr("aria-hidden", "true").class("tl-leader"),
			h.span
				.class("tl-value")
				.children(isDone ? formatSeconds(at - startedAt(steps)) : "–"),
		);
};

/**
 * A sleep as a thin bar between two steps. The sleep running now fills in
 * orange in real time and counts down. A finished one shows how long it
 * really took, and a mark if the page reloaded during it.
 */
const SleepRow = (
	h: H,
	maybeRun: Option.Option<OrderRun>,
	sleep: SleepLine,
	index: number,
): Node => {
	const state = Option.match(maybeRun, {
		onNone: () => "pending" as const,
		onSome: (run) => lineState(index, currentIndex(run.steps)),
	});
	const moments = Option.match(maybeRun, {
		onNone: () => [],
		onSome: (run) => momentsIn(run, sleep, index),
	});
	const fill = Option.match(maybeRun, {
		onNone: () => null,
		onSome: (run) => {
			switch (state) {
				case "current":
					return h.span
						.key(`fill-${run.key}-${index}`)
						.class("tl-fill")
						.style(sleepTiming(run, sleep));
				case "done":
					return h.span.class("tl-fill tl-fill-done");
				case "pending":
					return null;
			}
		},
	});
	const value = Option.match(maybeRun, {
		onNone: (): Node | string => "",
		onSome: (run): Node | string => {
			switch (state) {
				case "current":
					return h.span.children(Countdown(h, run, sleep), " left");
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

	return h.li
		.class("tl-row tl-sleep", state === "current" && "tl-live")
		.children(
			h.span.class("tl-name").children(`Sleep ${sleep.durationMs / 1000}s`),
			h.span
				.attr("aria-hidden", "true")
				.class("tl-bar")
				.children(
					fill,
					moments.map((moment) => MomentTick(h, moment, "tl-joined")),
				),
			h.span.class("tl-value").children(value),
		);
};

const Timeline = (h: H, maybeRun: Option.Option<OrderRun>): Node => {
	const steps = Option.match(maybeRun, {
		onNone: () => [],
		onSome: (run) => run.steps,
	});
	return h.ol
		.attr("aria-label", "Timeline")
		.class("timeline")
		.children(
			WORKFLOW.map((line, index) =>
				line.kind === "step"
					? StepRow(h, steps, line)
					: SleepRow(h, maybeRun, line, index),
			),
		);
};

/**
 * The one large number: how long the order has run. During a sleep CSS
 * counts it up from the saved steps, so a reload does not reset it.
 */
const Elapsed = (h: H, maybeRun: Option.Option<OrderRun>): Node => {
	const big = (key: string, isLive: boolean, value: Node | string) =>
		h.p
			.key(key)
			.class("elapsed-value", isLive && "text-orange")
			.children(value);
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
					h.span.class("elapsed-clock").style({
						...sleepTiming(run, sleep),
						"--from": `${fromTenths}`,
						"--to": `${fromTenths + Math.round(sleep.durationMs / 100)}`,
					}),
				),
			};
		},
	});
	return h.div
		.class("elapsed")
		.children(h.p.class("side-label").children(content.label), content.value);
};

// ACTIONS

const StartButton = (h: H, label: string): Node =>
	h.button
		.key(`start-${label}`)
		.id("start-order")
		.attr("type", "button")
		.on("click", Message.ClickedStartOrder())
		.class(primaryClass)
		.children(label, h.span.attr("aria-hidden", "true").children("→"));

/** A ring that empties as the sleep runs out, on the same clock as the sleep. */
const Timer = (h: H, run: OrderRun, sleep: SleepLine): Node =>
	h
		.el("svg")
		.attrs({ "aria-hidden": "true", viewBox: "0 0 20 20", class: "timer" })
		.children(
			h.el("circle").attr("class", "timer-track"),
			h
				.el("circle")
				.attrs({
					class: "timer-left",
					style: `animation-duration:${sleep.durationMs}ms;animation-delay:-${run.sleptMs}ms`,
				}),
		);

/**
 * During a sleep the next thing to do is stop the actor that runs the
 * workflow. The ring shows how long the sleep has left.
 */
const StopButton = (h: H, run: OrderRun, sleep: SleepLine): Node =>
	h.button
		.key(`stop-${run.key}-${sleep.lineNumber}-${run.wokeAt.length}`)
		.attrs({ type: "button", "data-action": "stop" })
		.on("click", Message.ClickedStopActor())
		.class(primaryClass)
		.children("Stop the actor", Timer(h, run, sleep));

/** While the actor is down, the page holds no connection. This opens one again. */
const ReconnectButton = (h: H): Node =>
	h.button
		.key("reconnect")
		.attrs({ type: "button", "data-action": "reconnect" })
		.on("click", Message.ClickedReconnect())
		.class(primaryClass)
		.children("Reconnect now", h.span.attr("aria-hidden", "true").children("↻"));

/** A reload also rejoins the run, so it stays, as a quiet second choice. */
const ReloadLink = (h: H): Node =>
	h.button
		.attrs({ type: "button", "data-action": "reload" })
		.on("click", Message.ClickedReload())
		.class("reload-link", focusClass)
		.children("Or reload this page");

const WaitingButton = (h: H, label: string): Node =>
	h.button
		.key(`waiting-${label}`)
		.attr("type", "button")
		.disabled(true)
		.class(primaryClass)
		.children(
			label,
			h.span.attr("aria-hidden", "true").class("blink").children("…"),
		);

const Action = (h: H, maybeRun: Option.Option<OrderRun>): Node =>
	h.div.class("actions actions-stack").children(
		Option.match(maybeRun, {
			onNone: () => [StartButton(h, "Start an order")],
			onSome: (run) => {
				const sleep = currentSleep(run.steps);
				if (run.isDisconnected) return [ReconnectButton(h)];
				if (isStopped(run)) return [WaitingButton(h, "Reconnecting")];
				if (sleep !== undefined)
					return [StopButton(h, run, sleep), ReloadLink(h)];
				if (isDone(run.steps)) return [StartButton(h, "Start another order")];
				return [
					WaitingButton(h, run.isKnown ? "Running" : "Reading the order"),
				];
			},
		}),
	);

const Side = (h: H, maybeRun: Option.Option<OrderRun>): Node =>
	h.aside
		.class("side")
		.children(
			h.div
				.class("side-head")
				.children(
					h.p
						.class("side-label flex justify-between gap-4")
						.children(
							h.span.children("Order key"),
							// Each start of the actor counts. A stop and a start again show here.
							Option.match(
								Option.filter(maybeRun, ({ wokeAt }) => wokeAt.length > 0),
								{
									onNone: () => null,
									onSome: ({ key, wokeAt }) =>
										h.span
											.key(`wakes-${key}-${wokeAt.length}`)
											.class(wokeAt.length > 1 && "pop text-orange-text")
											.children(`Actor started ${wokeAt.length}×`),
								},
							),
						),
					Option.match(maybeRun, {
						onNone: () => h.p.class("text-ink/35").children("None yet"),
						onSome: ({ key }) =>
							h.p.key(key).class("fade-in truncate").children(key),
					}),
				),
			Elapsed(h, maybeRun),
			Timeline(h, maybeRun),
			Action(h, maybeRun),
		);

/** One line that says what happened and what to do next. */
const OrderCaption = (h: H, maybeRun: Option.Option<OrderRun>): Node =>
	Option.match(maybeRun, {
		onNone: () =>
			Caption(h, "idle", [
				"Starts an ",
				CodeWord(h, "Order"),
				" workflow on the server. It saves each step before it runs the next.",
			]),
		onSome: (run) => {
			const hasStopped = Option.isSome(run.maybeStop);
			const hasJoined = Option.isSome(run.maybeJoinedAtMs);
			if (isDone(run.steps)) {
				const ats = run.steps.map((step) => step.at);
				const took = formatSeconds(Math.max(...ats) - Math.min(...ats));
				if (hasStopped) {
					return Caption(h, `done-stopped-${run.key}`, [
						`Shipped in ${took}. The actor stopped mid-run and started again, and no step ran twice.`,
					]);
				}
				return Caption(h, `done-${run.key}`, [
					hasJoined
						? `Shipped in ${took}. The workflow ran on while the page reloaded.`
						: `Shipped in ${took}. Next time, stop the actor while it sleeps.`,
				]);
			}
			if (run.isDisconnected) {
				return Caption(h, `stopped-${run.key}`, [
					"The actor is stopped and this page let go of it. Nothing runs the workflow now. When the sleep ends, RivetKit wakes the actor by itself.",
				]);
			}
			if (currentSleep(run.steps) === undefined) {
				return Caption(h, "running", ["The workflow is running."]);
			}
			if (hasStopped) {
				return Caption(h, `restarted-${run.key}-${run.wokeAt.length}`, [
					"The actor started again. The workflow replayed its history, skipped the finished steps, and went on from the same step.",
				]);
			}
			if (hasJoined) {
				return Caption(h, `joined-${run.key}`, [
					"The page reloaded, read the saved steps with ",
					CodeWord(h, "GetStatus"),
					", and joined the run where it was.",
				]);
			}
			return Caption(h, "sleeping", [
				"The workflow sleeps on the server. Stop its actor and watch it come back.",
			]);
		},
	});

/** The line over the code: what the actor is doing now. */
const Subject = (h: H, maybeRun: Option.Option<OrderRun>): Node =>
	Option.match(
		Option.filter(maybeRun, (run) => run.isDisconnected || isStopped(run)),
		{
			onNone: () => h.span.children("The workflow, running"),
			onSome: () =>
				h.span
					.class("text-orange")
					.children(
						"Actor stopped, memory gone",
						h.span.class("blink").children(" ■"),
					),
		},
	);

// SLIDE

export const OrderSlide = (
	h: H,
	model: Model,
	feed: ReadonlyArray<FeedEvent>,
): Node => {
	const maybeRun = followedOrder(model);
	const card = CodeCard(h, {
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
					marks: marksOf(h, run),
					maybeFocus: isDown ? Option.some(new Set<number>()) : focusOf(run),
					noteLines: NOTE_LINES,
					lineData: lineDataOf(run.steps),
				};
			},
		}),
		subject: Subject(h, maybeRun),
		footer: Feed(h, feed),
	});

	return h.div
		.attr(
			"data-order",
			Option.match(maybeRun, {
				onNone: () => undefined,
				onSome: ({ key }) => key,
			}),
		)
		.class("slide")
		.children(
			Kicker(h, "Durable workflow, one per order", sourceLinkOf(ORDER_CODE)),
			h.h1.class("title").children("Order workflow"),
			h.div.class("slide-body").children(card, Side(h, maybeRun)),
			OrderCaption(h, maybeRun),
		);
};
