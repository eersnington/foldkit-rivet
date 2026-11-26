import { UiStruct } from "@effect/ui";
import { Array, Option } from "effect";
import type { OrderStep } from "../../shared/api.ts";
import { AppDef } from "./app.ts";
import {
	BURST_SIZE,
	MAX_FEED_EVENTS,
	MAX_ORDERS,
	MAX_RECENT_CALLS,
	RECONNECT_AFTER_SLEEP_MS,
} from "./constant.ts";
import {
	GenerateOrderKey,
	Increment,
	LoadCount,
	LoadOrder,
	OpenClient,
	PlayCue,
	ReloadPage,
	SaveSettings,
	StopActor,
	TimestampFeedEvent,
	WaitForSleepEnd,
} from "./command.ts";
import { Message } from "./message.ts";
import {
	ConnectionState,
	type CounterState,
	followedOrder,
	isStopped,
	type Model,
	type OrderRun,
	settingsOf,
} from "./model.ts";
import { Cue } from "./sound.ts";
import { WORKFLOW } from "./source.ts";
import {
	currentIndex,
	currentSleep,
	isDone,
	startOffsetMs,
} from "./workflow.ts";

const withError = (model: Model, error: string): Model =>
	UiStruct.evolve(model, { maybeError: Option.some(error) });

/** The second window saves nothing, so it never changes the first window's settings. */
const saveSettings = (model: Model) =>
	model.isSecondWindow
		? []
		: [SaveSettings.make({ settings: settingsOf(model) })];

const playCue = (cue: Cue) => PlayCue.make({ cue });

/** Every Command that `update` runs. */
type AppCommand =
	| ReturnType<typeof GenerateOrderKey.make>
	| ReturnType<typeof Increment.make>
	| ReturnType<typeof LoadCount.make>
	| ReturnType<typeof LoadOrder.make>
	| ReturnType<typeof OpenClient.make>
	| ReturnType<typeof PlayCue.make>
	| ReturnType<typeof ReloadPage.make>
	| ReturnType<typeof SaveSettings.make>
	| ReturnType<typeof StopActor.make>
	| ReturnType<typeof TimestampFeedEvent.make>
	| ReturnType<typeof WaitForSleepEnd.make>;

// COUNTER

const withCounter = (
	model: Model,
	change: (counter: CounterState) => CounterState,
): Model => UiStruct.evolve(model, { counter: change });

/**
 * A call result and an event can arrive in either order. The count only
 * grows, so the largest value is the newest. A count that arrives also
 * means the counter answers again, so the last error goes.
 */
const withCount = (model: Model, count: number): Model => {
	const counter = UiStruct.evolve(model.counter, {
		maybeCount: (maybeCount) =>
			Option.some(
				Math.max(
					count,
					Option.getOrElse(maybeCount, () => count),
				),
			),
	});
	return UiStruct.evolve(model, {
		counter: () => counter,
		maybeError: () => Option.none(),
	});
};

// ORDER

/**
 * Adds the steps the page did not know yet. `sleptMsSince` says how long ago
 * a step finished, so the sleep after it starts its progress at the right
 * place. A restored run that is still going records where the page joined it.
 */
const withOrderSteps = (
	model: Model,
	key: string,
	steps: ReadonlyArray<OrderStep>,
	latestFrom: OrderRun["latestFrom"],
	sleptMsSince: (at: number) => number,
): Model =>
	UiStruct.evolve(model, {
		orders: (orders) =>
			orders.map((run) => {
				if (run.key !== key) {
					return run;
				}
				const added = steps.filter(
					({ status }) => !run.steps.some((step) => step.status === status),
				);
				if (added.length === 0) {
					return run;
				}

				const merged = [...run.steps, ...added];
				const latestAt = Math.max(...merged.map((step) => step.at));
				const sleptMs = Math.min(
					sleptMsSince(latestAt),
					currentSleep(merged)?.durationMs ?? 0,
				);
				const isJoining =
					run.isRestored &&
					Option.isNone(run.maybeJoinedAtMs) &&
					!isDone(merged);
				return {
					...run,
					steps: merged,
					latestFrom,
					sleptMs,
					maybeJoinedAtMs: isJoining
						? Option.some(startOffsetMs(currentIndex(merged)) + sleptMs)
						: run.maybeJoinedAtMs,
				};
			}),
	});

/** The cue for a finished step: a note that climbs with the step, and a chord for the last one. */
const stepCue = (status: OrderStep["status"]): Cue => {
	const index = WORKFLOW.findIndex(
		(line) => line.kind === "step" && line.status === status,
	);
	return index === WORKFLOW.length - 1
		? Cue.Chord()
		: Cue.Note({ degree: index * 2 });
};

const newRun = (key: string): OrderRun => ({
	key,
	steps: [],
	latestFrom: "read",
	sleptMs: 0,
	isRestored: false,
	isKnown: true,
	maybeJoinedAtMs: Option.none(),
	wokeAt: [],
	isDisconnected: false,
	maybeStop: Option.none(),
});

const withRun = (
	model: Model,
	key: string,
	change: (run: OrderRun) => OrderRun,
): Model =>
	UiStruct.evolve(model, {
		orders: (orders) =>
			orders.map((run) => (run.key === key ? change(run) : run)),
	});

/**
 * Where a run is now, in ms from its start, if it is in a sleep: the start of
 * the sleep plus how long ago its step finished, at most the whole sleep.
 */
const sleepingAtMs = (run: OrderRun, now: number) => {
	const sleep = currentSleep(run.steps);
	if (sleep === undefined) return Option.none();
	const latestAt = Math.max(...run.steps.map((step) => step.at));
	const sleptMs = Math.min(Math.max(0, now - latestAt), sleep.durationMs);
	return Option.some(startOffsetMs(currentIndex(run.steps)) + sleptMs);
};

// UPDATE

export const update = AppDef.update(($, message) => {
	const model = $.model;
	const next = (
		nextModel: Model,
		commands: ReadonlyArray<AppCommand> = [],
	) => $.set(nextModel).run(...commands);

	return Message.match(message, {
		// Page

		// The Router followed a link. The tab click already played its tick.
		ChangedRoute: ({ route }) =>
			next(UiStruct.evolve(model, { route: () => route })),
		ClickedTab: () => next(model, [playCue(Cue.Tick())]),
		InteractedWithPage: () =>
			next(UiStruct.evolve(model, { hasInteracted: true })),
		ClickedSound: () => {
			const soundChanged = UiStruct.evolve(model, {
				isSoundOn: (isSoundOn) => !isSoundOn,
			});
			return next(soundChanged, [
				...saveSettings(soundChanged),
				playCue(Cue.Tick()),
			]);
		},
		TimestampedFeedEvent: ({ event }) =>
			next(
				UiStruct.evolve(model, {
					feed: (feed) => [event, ...feed].slice(0, MAX_FEED_EVENTS),
				}),
			),

		// Counter

		ClickedIncrement: () =>
			next(
				withCounter(model, (counter) =>
					UiStruct.evolve(counter, {
						pendingIncrements: (pending) => pending + 1,
						presses: (presses) => presses + 1,
					}),
				),
				[Increment.make({ maybeBurstId: Option.none() })],
			),
		ClickedBurst: () => {
			const id = model.counter.bursts;
			return next(
				withCounter(model, (counter) =>
					UiStruct.evolve(counter, {
						pendingIncrements: (pending) => pending + BURST_SIZE,
						bursts: (bursts) => bursts + 1,
						maybeBurst: () => Option.some({ id, results: [] }),
					}),
				),
				// `Increment` runs concurrently, so the calls of one burst overlap.
				[
					playCue(Cue.Tick()),
					...Array.makeBy(BURST_SIZE, () =>
						Increment.make({ maybeBurstId: Option.some(id) }),
					),
				],
			);
		},
		ClickedOpenClient: () => next(model, [OpenClient.make()]),
		SucceededLoadCount: ({ count }) => next(withCount(model, count)),
		FailedLoadCount: ({ error }) => next(withError(model, error)),
		SucceededIncrement: ({ count, tookMs, maybeBurstId }) => {
			const result = { count, tookMs };
			const maybeBurst = Option.filter(model.counter.maybeBurst, (burst) =>
				Option.contains(maybeBurstId, burst.id),
			);
			// A burst climbs the scale in the order its results come back.
			const cue = Option.match(maybeBurst, {
				onNone: () => Cue.Note({ degree: count }),
				onSome: (burst) => Cue.Note({ degree: burst.results.length }),
			});
			return next(
				withCounter(withCount(model, count), (counter) =>
					UiStruct.evolve(counter, {
						recentCalls: (calls) => [...calls, result].slice(-MAX_RECENT_CALLS),
						maybeBurst: (current) =>
							Option.isSome(maybeBurst)
								? Option.map(current, (burst) => ({
										...burst,
										results: [...burst.results, result],
									}))
								: current,
					}),
				),
				[playCue(cue)],
			);
		},
		FailedIncrement: ({ error }) =>
			next(
				withCounter(withError(model, error), (counter) =>
					UiStruct.evolve(counter, {
						pendingIncrements: (pending) => Math.max(0, pending - 1),
					}),
				),
			),
		// Events sent while the connection was down are lost, so read again.
		ConnectedCounter: () =>
			next(
				UiStruct.evolve(model, {
					connection: () => ConnectionState.Connected(),
				}),
				[LoadCount.make()],
			),
		// An event that no call of this page waits for came from another client.
		ChangedCount: ({ count }) => {
			const isRemote = model.counter.pendingIncrements === 0;
			return next(
				withCounter(withCount(model, count), (counter) =>
					UiStruct.evolve(counter, {
						pendingIncrements: (pending) => Math.max(0, pending - 1),
						maybeLastChange: () => Option.some({ count, isRemote }),
					}),
				),
				[
					TimestampFeedEvent.make({
						name: "CountChanged",
						text: `{ count: ${count} }`,
						source: isRemote ? "another window" : "this window",
					}),
					...(isRemote ? [playCue(Cue.Echo({ degree: count }))] : []),
				],
			);
		},
		FailedCounterConnection: ({ error }) =>
			next(
				UiStruct.evolve(withError(model, error), {
					connection: () => ConnectionState.Disconnected(),
				}),
			),

		// Order

		ClickedStartOrder: () =>
			next(model, [GenerateOrderKey.make(), playCue(Cue.Tick())]),
		// The subscription connects to the new order, and that starts its workflow.
		GeneratedOrderKey: ({ key }) => {
			const withNewRun = UiStruct.evolve(model, {
				orders: (orders) => [newRun(key), ...orders].slice(0, MAX_ORDERS),
			});
			return next(withNewRun, saveSettings(withNewRun));
		},
		ClickedReload: () =>
			next(UiStruct.evolve(model, { isReloading: true }), [
				playCue(Cue.PowerDown()),
				ReloadPage.make(),
			]),
		// The saved steps are the source of truth after a connect or a reload.
		ConnectedOrder: ({ key }) => next(model, [LoadOrder.make({ key })]),
		SucceededLoadOrder: ({ key, steps, wokeAt, loadedAt }) => {
			const loaded = withOrderSteps(model, key, steps, "read", (at) =>
				Math.max(0, loadedAt - at),
			);
			// A stopped actor that reports a new start has started again.
			const hasRestarted = model.orders.some(
				(run) =>
					run.key === key &&
					isStopped(run) &&
					wokeAt.length > run.wokeAt.length,
			);
			return next(
				withRun(loaded, key, (run) => ({ ...run, isKnown: true, wokeAt })),
				hasRestarted ? [playCue(Cue.Note({ degree: 7 }))] : [],
			);
		},
		FailedLoadOrder: ({ error }) => next(withError(model, error)),
		ChangedOrderStatus: ({ key, step }) =>
			next(withOrderSteps(model, key, [step], "event", () => 0), [
				TimestampFeedEvent.make({
					name: "StatusChanged",
					text: `{ status: "${step.status}" }`,
					source: key,
				}),
				playCue(stepCue(step.status)),
			]),
		// The connection of a stopped actor closes. That is the point, not an error.
		FailedOrderConnection: ({ key, error }) =>
			next(
				model.orders.some(
					(run) => run.key === key && (run.isDisconnected || isStopped(run)),
				)
					? model
					: withError(model, error),
			),
		// The page lets go of its connection first, so no client wakes the actor.
		ClickedStopActor: () =>
			Option.match(
				Option.filter(
					followedOrder(model),
					(run) =>
						currentSleep(run.steps) !== undefined &&
						!run.isDisconnected &&
						!isStopped(run),
				),
				{
					onNone: () => next(model),
					onSome: ({ key }) =>
						next(
							withRun(model, key, (run) => ({ ...run, isDisconnected: true })),
							[StopActor.make({ key }), playCue(Cue.PowerDown())],
						),
				},
			),
		SucceededStopActor: ({ key, stoppedAt }) =>
			Option.match(
				Option.fromNullishOr(model.orders.find((run) => run.key === key)),
				{
					onNone: () => next(model),
					onSome: (run) => {
						const wakesBefore = run.wokeAt.length;
						const sleep = currentSleep(run.steps);
						const latestAt = Math.max(...run.steps.map((step) => step.at));
						const sleepEndsInMs =
							sleep === undefined
								? 0
								: Math.max(0, latestAt + sleep.durationMs - stoppedAt);
						return next(
							withRun(model, key, (current) => ({
								...current,
								maybeStop: Option.map(
									sleepingAtMs(current, stoppedAt),
									(atMs) => ({ atMs, wakesBefore }),
								),
							})),
							[
								WaitForSleepEnd.make({
									key,
									wakesBefore,
									delayMs: sleepEndsInMs + RECONNECT_AFTER_SLEEP_MS,
								}),
							],
						);
					},
				},
			),
		FailedStopActor: ({ error }) =>
			next(
				UiStruct.evolve(withError(model, error), {
					orders: (orders) =>
						orders.map((run) => ({ ...run, isDisconnected: false })),
				}),
			),
		ClickedReconnect: () =>
			Option.match(
				Option.filter(followedOrder(model), (run) => run.isDisconnected),
				{
					onNone: () => next(model),
					onSome: ({ key }) =>
						next(
							withRun(model, key, (run) => ({ ...run, isDisconnected: false })),
						),
				},
			),
		// The sleep is over, so RivetKit has woken the actor by now. The page connects to look.
		CompletedWaitForSleepEnd: ({ key, wakesBefore }) =>
			next(
				withRun(model, key, (run) =>
					Option.exists(
						run.maybeStop,
						(stop) => stop.wakesBefore === wakesBefore,
					)
						? { ...run, isDisconnected: false }
						: run,
				),
			),
	});
});
