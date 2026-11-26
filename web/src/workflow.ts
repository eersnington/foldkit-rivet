// Where an order is in its workflow. Every answer comes from the steps the
// workflow saved and from `WORKFLOW`, which is read from the server source.

import type { OrderStep } from "../../shared/api.ts";
import { type SleepLine, WORKFLOW } from "./source.ts";

/**
 * The index in `WORKFLOW` of the line the order runs now. A step returns as
 * soon as it saves its status, so after a step the order is on the line after
 * it. When every step is done, this is `WORKFLOW.length`.
 */
export const currentIndex = (steps: ReadonlyArray<OrderStep>): number => {
	const doneIndexes = WORKFLOW.flatMap((line, index) =>
		line.kind === "step" && steps.some((step) => step.status === line.status)
			? [index]
			: [],
	);
	return doneIndexes.length === 0 ? 0 : Math.max(...doneIndexes) + 1;
};

export const isDone = (steps: ReadonlyArray<OrderStep>) =>
	currentIndex(steps) === WORKFLOW.length;

/** The current line when it is a `Workflow.sleep`. */
export const currentSleep = (
	steps: ReadonlyArray<OrderStep>,
): SleepLine | undefined => {
	const line = WORKFLOW[currentIndex(steps)];
	return line?.kind === "sleep" ? line : undefined;
};

export type LineState = "done" | "current" | "pending";

export const lineState = (index: number, current: number): LineState =>
	index < current ? "done" : index === current ? "current" : "pending";

/** When a line starts, in ms from the start of the workflow, if every sleep runs on time. */
export const startOffsetMs = (index: number) =>
	WORKFLOW.slice(0, index).reduce(
		(total, line) => total + (line.kind === "sleep" ? line.durationMs : 0),
		0,
	);

/** When the step that saved `status` finished, in Unix ms. */
export const finishedAt = (
	steps: ReadonlyArray<OrderStep>,
	status: OrderStep["status"],
) => steps.find((step) => step.status === status)?.at;
