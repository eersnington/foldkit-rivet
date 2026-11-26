import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "../message.ts";

export const SOURCE_URL = "https://github.com/eersnington/foldkit-rivet";

export const focusClass =
	"focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-orange";

/** The one obvious next action of a demo. */
export const primaryClass = `button button-primary ${focusClass}`;

/** An action beside the primary one. */
export const secondaryClass = `button button-secondary ${focusClass}`;

export const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

/**
 * The line under a slide that says what just happened, or what to do.
 * A new `key` draws the new text in.
 */
export const captionView = (
	key: string,
	text: ReadonlyArray<string | Html>,
	h: HtmlBuilder<Message>,
): Html =>
	h.footer(
		[h.Class("slide-foot")],
		[h.keyed("p")(key, [h.AriaLive("polite"), h.Class("fade-in")], text)],
	);

/** An identifier inside a caption. It keeps its case. */
export const codeWord = (text: string, h: HtmlBuilder<Message>): Html =>
	h.code([h.Class("code-word")], [text]);

/** The orange square, a label, and a link to the source on the other side. */
export const kickerView = (
	label: string,
	source: { readonly text: string; readonly href: string },
	h: HtmlBuilder<Message>,
): Html =>
	h.div(
		[h.Class("kicker")],
		[
			h.p(
				[h.Class("text-orange-text")],
				[h.span([h.AriaHidden(true), h.Class("kicker-mark")], []), label],
			),
			h.a(
				[
					h.Href(source.href),
					h.Target("_blank"),
					h.Rel("noreferrer"),
					h.Class(`text-ink/55 hover:text-ink ${focusClass}`),
				],
				["Source: ", h.span([h.Class("normal-case")], [source.text])],
			),
		],
	);
