import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import type { Message } from "../message.ts";

/** The builders of the app's views. */
export type H = Html.H<Message>;

/** One node of the app's views. */
export type Node = View.Content<Message>;

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
export const Caption = (
	h: H,
	key: string,
	text: ReadonlyArray<string | Node>,
): Node =>
	h.footer
		.class("slide-foot")
		.children(
			h.p
				.key(key)
				.attr("aria-live", "polite")
				.class("fade-in")
				.children(text),
		);

/** An identifier inside a caption. It keeps its case. */
export const CodeWord = (h: H, text: string): Node =>
	h.code.class("code-word").children(text);

/** The orange square, a label, and a link to the source on the other side. */
export const Kicker = (
	h: H,
	label: string,
	source: { readonly text: string; readonly href: string },
): Node =>
	h.div
		.class("kicker")
		.children(
			h.p
				.class("text-orange-text")
				.children(
					h.span.attr("aria-hidden", "true").class("kicker-mark"),
					label,
				),
			h.a
				.attrs({ href: source.href, target: "_blank", rel: "noreferrer" })
				.class(`text-ink/55 hover:text-ink ${focusClass}`)
				.children("Source: ", h.span.class("normal-case").children(source.text)),
		);
