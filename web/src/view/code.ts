import { Option } from "effect";
import type { FeedEvent } from "../model.ts";
import type { Block, Line, TokenKind } from "../source.ts";
import { type H, type Node, SOURCE_URL } from "./shared.ts";

/** Ink for the code, grey for its frame, and orange for calls, as in a printed listing. */
const TOKEN_CLASS: Record<TokenKind, string> = {
	plain: "",
	comment: "text-ink/40",
	string: "text-ink/75",
	keyword: "text-ink/50",
	call: "text-orange-text",
	number: "text-orange-text",
};

/** The block's lines on GitHub, as link text and a URL. */
export const sourceLinkOf = (block: Block) => {
	const first = block.lines[0].number;
	const last = block.lines[block.lines.length - 1].number;
	return {
		text: `${block.path}:${first}-${last}`,
		href: `${SOURCE_URL}/blob/main/${block.path}#L${first}-L${last}`,
	};
};

/** What the runtime adds to one line of a block. */
export type LineMark = {
	/** The line ran, so its gutter shows a tick. */
	readonly isDone: boolean;
	/** Layers behind the line, for example the progress of a sleep. */
	readonly under: ReadonlyArray<Node>;
	/** A value at the end of the line. Only lines in `noteLines` show one. */
	readonly maybeNote: Option.Option<Node>;
};

/**
 * The bar on the running line, as line numbers of the file. After a live
 * step it shows the path the code took: the step, the line of `finish` that
 * sent the event, then the line the workflow runs now. At rest it sits on `to`.
 */
export type Bar = {
	/** A new key replays the motion. */
	readonly key: string;
	readonly motion: "rest" | "step" | "last-step";
	readonly from: number;
	readonly via: number;
	readonly call: number;
	readonly to: number;
};

export type BlockOptions = {
	readonly maybeBar: Option.Option<Bar>;
	readonly marks: ReadonlyMap<number, LineMark>;
	/** Line numbers that stay bright while the rest of the block dims. */
	readonly maybeFocus: Option.Option<ReadonlySet<number>>;
	/** Lines that can end in a note. The block keeps room for a note on each. */
	readonly noteLines: ReadonlySet<number>;
	/** `data-*` attributes of lines, by line number, for tests. */
	readonly lineData: ReadonlyMap<number, Readonly<Record<string, string>>>;
};

/** A block with nothing added to it. */
export const PLAIN_BLOCK: BlockOptions = {
	maybeBar: Option.none(),
	marks: new Map(),
	maybeFocus: Option.none(),
	noteLines: new Set(),
	lineData: new Map(),
};

// The widths of a row, in characters of the monospace font. The type size
// is set from them, so the widest row of a block fits the card exactly.
const TAB_COLUMNS = 2;
const GUTTER_COLUMNS = 5;
const NOTE_COLUMNS = 14;

const columnsOf = (line: Line) =>
	line.indent.replaceAll("\t", " ".repeat(TAB_COLUMNS)).length +
	line.tokens.reduce((total, token) => total + token.text.length, 0);

const blockColumns = (block: Block, noteLines: ReadonlySet<number>) =>
	GUTTER_COLUMNS +
	Math.max(
		...block.lines.map(
			(line) =>
				columnsOf(line) + (noteLines.has(line.number) ? NOTE_COLUMNS : 0),
		),
	);

const BarMark = (h: H, block: Block, bar: Bar): Node => {
	const first = block.lines[0].number;
	return h.span
		.key(bar.key)
		.attr("aria-hidden", "true")
		.class("bar", bar.motion !== "rest" && `bar-${bar.motion}`)
		.style({
			"--from": `${bar.from - first}`,
			"--via": `${bar.via - first}`,
			"--call": `${bar.call - first}`,
			"--to": `${bar.to - first}`,
		});
};

const CodeLine = (h: H, line: Line, options: BlockOptions): Node => {
	const { number, indent, tokens } = line;
	const mark = options.marks.get(number);
	const isDim = Option.match(options.maybeFocus, {
		onNone: () => false,
		onSome: (focus) => !focus.has(number),
	});
	const isDone = mark?.isDone === true;
	// Where the bar rests. Narrow screens wrap long rows, so they mark this row instead of moving a bar.
	const isAt = Option.exists(
		options.maybeBar,
		(bar) => bar.motion !== "last-step" && bar.to === number,
	);
	const indentColumns = indent.replaceAll("\t", " ".repeat(TAB_COLUMNS)).length;
	const maybeNote = Option.flatMap(
		Option.fromNullishOr(mark),
		({ maybeNote }) => maybeNote,
	);

	const data = Object.fromEntries(
		Object.entries(options.lineData.get(number) ?? {}).map(([name, value]) => [
			`data-${name}`,
			value,
		]),
	);

	return h.li
		.attrs(data)
		.class("row", isDim && "row-dim", isAt && "row-at")
		.children(
			mark?.under ?? [],
			// A new element when the line finishes, so the tick pops in.
			h.span
				.key(isDone ? "done" : "open")
				.attr("aria-hidden", "true")
				.class("check", isDone && "pop-late")
				.children(isDone ? "✓" : ""),
			h.span.attr("aria-hidden", "true").class("number").children(`${number}`),
			h.code
				.class("code")
				.style({ "--indent": `${indentColumns}ch` })
				.children(
					indent,
					tokens.map(({ kind, text }) =>
						kind === "plain" ? text : h.span.class(TOKEN_CLASS[kind]).children(text),
					),
				),
			// A row that can carry a note always has the room for it, so a note never moves the rows.
			options.noteLines.has(number) &&
				h.span.class("note").children(Option.toArray(maybeNote)),
		);
};

export type CardOptions = {
	/** The card's `data-block` and key. */
	readonly name: string;
	readonly block: Block;
	readonly options: BlockOptions;
	/** What the code runs on, at the top right of the card. */
	readonly subject: Node;
	readonly footer: Node;
};

/**
 * One unbroken range of a file, in type as large as fits, with a link to its
 * lines on GitHub. The runtime draws on it: a bar on the running line, ticks
 * and values on the lines that ran.
 */
export const CodeCard = (
	h: H,
	{ name, block, options, subject, footer }: CardOptions,
): Node =>
	h.section
		.key(name)
		.attr("data-block", name)
		.class("card")
		.style({
			"--cols": `${blockColumns(block, options.noteLines)}`,
			"--rows": `${block.lines.length}`,
		})
		.children(
			h.header
				.class("card-edge card-head")
				.children(
					h.div.class("min-w-0 truncate").children(subject),
					h.span.class("hidden shrink-0 sm:inline").children(block.path),
				),
			h.div
				.class("card-body")
				.children(
					h.div
						.class("source")
						.children(
							Option.match(options.maybeBar, {
								onNone: () => null,
								onSome: (bar) => BarMark(h, block, bar),
							}),
							h.ol
								.class("relative")
								.children(block.lines.map((line) => CodeLine(h, line, options))),
						),
				),
			h.footer.class("card-edge card-foot").children(footer),
		);

/**
 * The latest events of the open demo, newest first. The newest one slides
 * in, and the older ones dim.
 */
export const Feed = (h: H, feed: ReadonlyArray<FeedEvent>): Node =>
	h.ol
		.id("feed")
		.attr("aria-label", "Events")
		.class("feed")
		.children(
			feed.length === 0
				? h.li.class("text-ink/35").children("No events yet")
				: feed.map((event, index) =>
						h.li
							.key(`${event.at}-${event.text}-${event.source}`)
							.attr("data-event", event.name)
							.class("feed-item", index === 0 && "feed-new")
							.children(
								h.span.class("text-ink").children(event.name),
								h.span.children(event.text),
								h.span
									.class(
										event.source === "another window"
											? "text-orange-text"
											: "text-ink/45",
									)
									.children(event.source),
							),
					),
		);
