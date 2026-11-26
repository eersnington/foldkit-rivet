import type { Client } from "@rivetkit/effect";
import { Array, Option } from "effect";
import type { Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";
import type { OrderStep } from "../../shared/api.ts";
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
	LoadExternal,
	LoadOrder,
	NavigateInternal,
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
import { urlToAppRoute } from "./route.ts";
import { Cue, type SpeakerService } from "./sound.ts";
import { WORKFLOW } from "./source.ts";
import {
	currentIndex,
	currentSleep,
	isDone,
	startOffsetMs,
} from "./workflow.ts";

type UpdateReturn = Update.Return<
	Model,
	Message,
	Client.Client | SpeakerService
>;

const withError = (model: Model, error: string): Model =>
	modifyFields(model, { maybeError: () => Option.some(error) });

/** The second window saves nothing, so it never changes the first window's settings. */
const saveSettings = (model: Model) =>
	model.isSecondWindow ? [] : [SaveSettings({ settings: settingsOf(model) })];

const playCue = (cue: Cue) => PlayCue({ cue });

// COUNTER

const withCounter = (
	model: Model,
	change: (counter: CounterState) => CounterState,
): Model => modifyFields(model, { counter: change });

/**
 * A call result and an event can arrive in either order. The count only
 * grows, so the largest value is the newest. A count that arrives also
 * means the counter answers again, so the last error goes.
 */
const withCount = (model: Model, count: number): Model => {
	const counter = modifyFields(model.counter, {
		maybeCount: (maybeCount) =>
			Option.some(
				Math.max(
					count,
					Option.getOrElse(maybeCount, () => count),
				),
			),
	});
	return modifyFields(model, {
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
	modifyFields(model, {
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
	modifyFields(model, {
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

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		// Page

		ClickedLink: ({ request }) =>
			UrlRequest.match<UpdateReturn>(request, {
				Internal: ({ url }) => ({
					model,
					commands: [
						NavigateInternal({ url: urlToString(url) }),
						playCue(Cue.Tick()),
					],
				}),
				External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
			}),
		ChangedUrl: ({ url }) => ({
			model: modifyFields(model, { route: () => urlToAppRoute(url) }),
		}),
		CompletedNavigateInternal: () => ({ model }),
		CompletedLoadExternal: () => ({ model }),
		InteractedWithPage: () => ({
			model: modifyFields(model, { hasInteracted: () => true }),
		}),
		ClickedSound: () => {
			const next = modifyFields(model, {
				isSoundOn: (isSoundOn) => !isSoundOn,
			});
			return {
				model: next,
				commands: [...saveSettings(next), playCue(Cue.Tick())],
			};
		},
		CompletedSaveSettings: () => ({ model }),
		AcquiredSpeaker: () => ({ model }),
		ReleasedSpeaker: () => ({ model }),
		// Sound is optional, so the page works on without it.
		FailedAcquireSpeaker: () => ({ model }),
		CompletedPlayCue: () => ({ model }),
		TimestampedFeedEvent: ({ event }) => ({
			model: modifyFields(model, {
				feed: (feed) => [event, ...feed].slice(0, MAX_FEED_EVENTS),
			}),
		}),

		// Counter

		ClickedIncrement: () => ({
			model: withCounter(model, (counter) =>
				modifyFields(counter, {
					pendingIncrements: (pending) => pending + 1,
					presses: (presses) => presses + 1,
				}),
			),
			commands: [Increment({ maybeBurstId: Option.none() })],
		}),
		ClickedBurst: () => {
			const id = model.counter.bursts;
			return {
				model: withCounter(model, (counter) =>
					modifyFields(counter, {
						pendingIncrements: (pending) => pending + BURST_SIZE,
						bursts: (bursts) => bursts + 1,
						maybeBurst: () => Option.some({ id, results: [] }),
					}),
				),
				// The runtime runs the Commands of one batch concurrently.
				commands: [
					playCue(Cue.Tick()),
					...Array.makeBy(BURST_SIZE, () =>
						Increment({ maybeBurstId: Option.some(id) }),
					),
				],
			};
		},
		ClickedOpenClient: () => ({ model, commands: [OpenClient()] }),
		CompletedOpenClient: () => ({ model }),
		SucceededLoadCount: ({ count }) => ({ model: withCount(model, count) }),
		FailedLoadCount: ({ error }) => ({ model: withError(model, error) }),
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
			return {
				model: withCounter(withCount(model, count), (counter) =>
					modifyFields(counter, {
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
				commands: [playCue(cue)],
			};
		},
		FailedIncrement: ({ error }) => ({
			model: withCounter(withError(model, error), (counter) =>
				modifyFields(counter, {
					pendingIncrements: (pending) => Math.max(0, pending - 1),
				}),
			),
		}),
		// Events sent while the connection was down are lost, so read again.
		ConnectedCounter: () => ({
			model: modifyFields(model, {
				connection: () => ConnectionState.Connected(),
			}),
			commands: [LoadCount()],
		}),
		// An event that no call of this page waits for came from another client.
		ChangedCount: ({ count }) => {
			const isRemote = model.counter.pendingIncrements === 0;
			return {
				model: withCounter(withCount(model, count), (counter) =>
					modifyFields(counter, {
						pendingIncrements: (pending) => Math.max(0, pending - 1),
						maybeLastChange: () => Option.some({ count, isRemote }),
					}),
				),
				commands: [
					TimestampFeedEvent({
						name: "CountChanged",
						text: `{ count: ${count} }`,
						source: isRemote ? "another window" : "this window",
					}),
					...(isRemote ? [playCue(Cue.Echo({ degree: count }))] : []),
				],
			};
		},
		FailedCounterConnection: ({ error }) => ({
			model: modifyFields(withError(model, error), {
				connection: () => ConnectionState.Disconnected(),
			}),
		}),

		// Order

		ClickedStartOrder: () => ({
			model,
			commands: [GenerateOrderKey(), playCue(Cue.Tick())],
		}),
		// The subscription connects to the new order, and that starts its workflow.
		GeneratedOrderKey: ({ key }) => {
			const next = modifyFields(model, {
				orders: (orders) => [newRun(key), ...orders].slice(0, MAX_ORDERS),
			});
			return { model: next, commands: saveSettings(next) };
		},
		ClickedReload: () => ({
			model: modifyFields(model, { isReloading: () => true }),
			commands: [playCue(Cue.PowerDown()), ReloadPage()],
		}),
		CompletedReloadPage: () => ({ model }),
		// The saved steps are the source of truth after a connect or a reload.
		ConnectedOrder: ({ key }) => ({ model, commands: [LoadOrder({ key })] }),
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
			return {
				model: withRun(loaded, key, (run) => ({
					...run,
					isKnown: true,
					wokeAt,
				})),
				commands: hasRestarted ? [playCue(Cue.Note({ degree: 7 }))] : [],
			};
		},
		FailedLoadOrder: ({ error }) => ({ model: withError(model, error) }),
		ChangedOrderStatus: ({ key, step }) => ({
			model: withOrderSteps(model, key, [step], "event", () => 0),
			commands: [
				TimestampFeedEvent({
					name: "StatusChanged",
					text: `{ status: "${step.status}" }`,
					source: key,
				}),
				playCue(stepCue(step.status)),
			],
		}),
		// The connection of a stopped actor closes. That is the point, not an error.
		FailedOrderConnection: ({ key, error }) => ({
			model: model.orders.some(
				(run) => run.key === key && (run.isDisconnected || isStopped(run)),
			)
				? model
				: withError(model, error),
		}),
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
					onNone: () => ({ model }),
					onSome: ({ key }) => ({
						model: withRun(model, key, (run) => ({
							...run,
							isDisconnected: true,
						})),
						commands: [StopActor({ key }), playCue(Cue.PowerDown())],
					}),
				},
			),
		SucceededStopActor: ({ key, stoppedAt }) =>
			Option.match(
				Option.fromNullishOr(model.orders.find((run) => run.key === key)),
				{
					onNone: () => ({ model }),
					onSome: (run) => {
						const wakesBefore = run.wokeAt.length;
						const sleep = currentSleep(run.steps);
						const latestAt = Math.max(...run.steps.map((step) => step.at));
						const sleepEndsInMs =
							sleep === undefined
								? 0
								: Math.max(0, latestAt + sleep.durationMs - stoppedAt);
						return {
							model: withRun(model, key, (current) => ({
								...current,
								maybeStop: Option.map(
									sleepingAtMs(current, stoppedAt),
									(atMs) => ({ atMs, wakesBefore }),
								),
							})),
							commands: [
								WaitForSleepEnd({
									key,
									wakesBefore,
									delayMs: sleepEndsInMs + RECONNECT_AFTER_SLEEP_MS,
								}),
							],
						};
					},
				},
			),
		FailedStopActor: ({ error }) => ({
			model: modifyFields(withError(model, error), {
				orders: (orders) =>
					orders.map((run) => ({ ...run, isDisconnected: false })),
			}),
		}),
		ClickedReconnect: () =>
			Option.match(
				Option.filter(followedOrder(model), (run) => run.isDisconnected),
				{
					onNone: () => ({ model }),
					onSome: ({ key }) => ({
						model: withRun(model, key, (run) => ({
							...run,
							isDisconnected: false,
						})),
					}),
				},
			),
		// The sleep is over, so RivetKit has woken the actor by now. The page connects to look.
		CompletedWaitForSleepEnd: ({ key, wakesBefore }) => ({
			model: withRun(model, key, (run) =>
				Option.exists(run.maybeStop, (stop) => stop.wakesBefore === wakesBefore)
					? { ...run, isDisconnected: false }
					: run,
			),
		}),
	});
