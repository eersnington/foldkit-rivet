// The server source that the page shows. Vite imports each file as text at
// build time, so the code on screen is the code that runs.

import { Duration, Option, Schema } from "effect";
import counterSource from "../../server/counter.ts?raw";
import orderSource from "../../server/order.ts?raw";
import { OrderStatus } from "../../shared/api.ts";

// TOKENS

export type TokenKind =
	| "plain"
	| "comment"
	| "string"
	| "keyword"
	| "call"
	| "number";

export type Token = { readonly kind: TokenKind; readonly text: string };

const TOKEN_PATTERN =
	/(\/\/.*$)|("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|const|return|function|yield|async|await|type|as)\b|\b([A-Za-z_]\w*)(?=\(|`|<)|\b(\d+)\b/g;

/** The kind of each capture group of `TOKEN_PATTERN`, in order. */
const GROUP_KINDS = ["comment", "string", "keyword", "call", "number"] as const;

/**
 * Enough of a tokenizer to color comments, strings, keywords and calls. A
 * line of a doc comment is one comment token.
 */
const tokenize = (code: string): ReadonlyArray<Token> => {
	if (code.startsWith("/**") || code.startsWith("*")) {
		return [{ kind: "comment", text: code }];
	}

	const tokens: Array<Token> = [];
	let end = 0;
	for (const match of code.matchAll(TOKEN_PATTERN)) {
		if (match.index > end) {
			tokens.push({ kind: "plain", text: code.slice(end, match.index) });
		}
		const group = GROUP_KINDS.findIndex(
			(_, index) => match[index + 1] !== undefined,
		);
		tokens.push({ kind: GROUP_KINDS[group], text: match[0] });
		end = match.index + match[0].length;
	}
	if (end < code.length) {
		tokens.push({ kind: "plain", text: code.slice(end) });
	}
	return tokens;
};

// FILES

type SourceFile = {
	readonly path: string;
	readonly texts: ReadonlyArray<string>;
};

const sourceFile = (path: string, source: string): SourceFile => ({
	path,
	texts: source.trimEnd().split("\n"),
});

const ORDER_FILE = sourceFile("server/order.ts", orderSource);
const COUNTER_FILE = sourceFile("server/counter.ts", counterSource);

// BLOCKS

export type Line = {
	/** The line number in the file, from 1. */
	readonly number: number;
	/** The indent left after the indent that every line of the block shares. */
	readonly indent: string;
	readonly tokens: ReadonlyArray<Token>;
};

/** One whole statement of a file. */
export type Block = {
	readonly path: string;
	readonly lines: ReadonlyArray<Line>;
};

const BRACKET_DEPTH: Readonly<Record<string, number>> = {
	"(": 1,
	"[": 1,
	"{": 1,
	")": -1,
	"]": -1,
	"}": -1,
};

/** How much a line opens or closes brackets. Brackets in strings and comments do not count. */
const depthChange = (tokens: ReadonlyArray<Token>) =>
	tokens
		.filter((token) => token.kind === "plain")
		.flatMap((token) => [...token.text])
		.reduce((depth, character) => depth + (BRACKET_DEPTH[character] ?? 0), 0);

const indentOf = (text: string) => text.length - text.trimStart().length;

/** The index of the first line of `file` that contains `needle`. A missing line is a programming error. */
const lineIndexOf = (file: SourceFile, needle: string) => {
	const index = file.texts.findIndex((text) => text.includes(needle));
	if (index < 0) {
		throw new Error(`${file.path} has no line that contains ${needle}`);
	}
	return index;
};

/**
 * The statement that starts on the first line containing `needle`. It ends on
 * the first line where every bracket is closed and the line ends in `;` or
 * `,`. A missing statement is a programming error, so it throws.
 */
const statementAt = (file: SourceFile, needle: string): Block => {
	const start = lineIndexOf(file, needle);

	let depth = 0;
	for (let end = start; end < file.texts.length; end++) {
		const tokensOfLine = tokenize(file.texts[end].trim());
		depth += depthChange(tokensOfLine);
		const trimmed = file.texts[end].trimEnd();
		const isEnd =
			depth === 0 && (trimmed.endsWith(";") || trimmed.endsWith(","));
		if (isEnd) {
			return blockOf(file, start, end);
		}
	}
	throw new Error(`The statement at ${needle} in ${file.path} has no end`);
};

const blockOf = (file: SourceFile, start: number, end: number): Block => {
	const texts = file.texts.slice(start, end + 1);
	const sharedIndent = Math.min(
		...texts.filter((text) => text.trim() !== "").map(indentOf),
	);
	return {
		path: file.path,
		lines: texts.map((text, offset) => ({
			number: start + offset + 1,
			indent: text.slice(sharedIndent, indentOf(text)),
			tokens: tokenize(text.trim()),
		})),
	};
};

const lastLineOf = (block: Block) => block.lines[block.lines.length - 1];

/** The number of the first line of `block` that contains `needle`. */
export const lineNumberOf = (block: Block, needle: string): number => {
	const line = block.lines.find(({ tokens }) =>
		tokens
			.map((token) => token.text)
			.join("")
			.includes(needle),
	);
	if (line === undefined) {
		throw new Error(`${block.path} shows no line that contains ${needle}`);
	}
	return line.number;
};

/** The workflow body: the `Effect.gen` that `Order.toLayer` returns. */
export const WORKFLOW_BODY = statementAt(ORDER_FILE, "return Effect.gen(");

/**
 * The order code on screen: `finish`, which saves a step and broadcasts it,
 * through the end of the workflow body. The lines are one unbroken range.
 */
export const ORDER_CODE = blockOf(
	ORDER_FILE,
	lineIndexOf(ORDER_FILE, "const finish = "),
	lastLineOf(WORKFLOW_BODY).number - 1,
);

/** The `Increment` action of the counter. */
export const INCREMENT = statementAt(COUNTER_FILE, "Increment: (");

// WORKFLOW

export type StepLine = {
	readonly kind: "step";
	readonly name: string;
	/** The status that the step saves, from its `finish(...)` call. */
	readonly status: OrderStatus;
	readonly lineNumber: number;
};

export type SleepLine = {
	readonly kind: "sleep";
	readonly name: string;
	/** The duration as the source writes it, for example `4 seconds`. */
	readonly duration: string;
	readonly durationMs: number;
	readonly lineNumber: number;
};

export type WorkflowLine = StepLine | SleepLine;

const STEP_PATTERN = /Workflow\.step\("([^"]+)", finish\("([^"]+)"\)\)/;
const SLEEP_PATTERN = /Workflow\.sleep\("([^"]+)", "([^"]+)"\)/;

const decodeStatus = Schema.decodeUnknownSync(OrderStatus);

const workflowLineOf = (
	text: string,
	lineNumber: number,
): Option.Option<WorkflowLine> => {
	const step = STEP_PATTERN.exec(text);
	if (step !== null) {
		return Option.some({
			kind: "step",
			name: step[1],
			status: decodeStatus(step[2]),
			lineNumber,
		});
	}

	const sleep = SLEEP_PATTERN.exec(text);
	if (sleep !== null) {
		const duration = Option.getOrThrowWith(
			Duration.fromInput(sleep[2] as Duration.Input),
			() => new Error(`${sleep[2]} is not a duration`),
		);
		return Option.some({
			kind: "sleep",
			name: sleep[1],
			duration: sleep[2],
			durationMs: Duration.toMillis(duration),
			lineNumber,
		});
	}

	return Option.none();
};

/** The `Workflow.step` and `Workflow.sleep` lines of the workflow body, in order. */
export const WORKFLOW: ReadonlyArray<WorkflowLine> = ORDER_FILE.texts.flatMap(
	(text, index) => {
		const lineNumber = index + 1;
		const isInBody =
			lineNumber >= WORKFLOW_BODY.lines[0].number &&
			lineNumber <= lastLineOf(WORKFLOW_BODY).number;
		return isInBody ? Option.toArray(workflowLineOf(text, lineNumber)) : [];
	},
);
