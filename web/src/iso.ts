// Isometric slabs and tiles drawn as inline SVG, in the style of the rivet.dev illustrations.
// Plan coordinates (x, y) are on the ground; z goes up. The look comes from the
// `iso-*` classes in styles.css, so the drawings follow the light and dark tokens.
import type { Html, HtmlBuilder } from "foldkit/html";

type Point = readonly [x: number, y: number];

const COS30 = Math.sqrt(3) / 2;
const CORNER_STEPS = 6;

/** Plan point to screen point, seen from above at 30 degrees. */
const project = (x: number, y: number, z: number): Point => [
	(x - y) * COS30,
	(x + y) / 2 - z,
];

/** A rounded rectangle on the ground, centered at (cx, cy). */
export type Footprint = {
	readonly cx: number;
	readonly cy: number;
	readonly width: number;
	readonly depth: number;
	readonly radius: number;
};

/** Points along one rounded corner, angles in degrees. */
const cornerArc = (
	{ cx, cy, width, depth, radius }: Footprint,
	signX: 1 | -1,
	signY: 1 | -1,
	from: number,
	to: number,
): ReadonlyArray<readonly [number, number]> => {
	const centerX = cx + signX * (width / 2 - radius);
	const centerY = cy + signY * (depth / 2 - radius);
	const steps = Math.max(1, Math.round((CORNER_STEPS * (to - from)) / 90));
	return Array.from({ length: steps + 1 }, (_, index) => {
		const angle = ((from + ((to - from) * index) / steps) * Math.PI) / 180;
		return [
			centerX + radius * Math.cos(angle),
			centerY + radius * Math.sin(angle),
		] as const;
	});
};

// The corner nearest the viewer is (+x, +y). The screen-left, bottom and
// screen-right extremes sit at 135, 45 and 315 degrees.
const outline = (f: Footprint) => [
	...cornerArc(f, 1, 1, 0, 90),
	...cornerArc(f, -1, 1, 90, 180),
	...cornerArc(f, -1, -1, 180, 270),
	...cornerArc(f, 1, -1, 270, 360),
];
const leftWallEdge = (f: Footprint) => [
	...cornerArc(f, 1, 1, 45, 90),
	...cornerArc(f, -1, 1, 90, 135),
];
const rightWallEdge = (f: Footprint) => [
	...cornerArc(f, 1, -1, 315, 360),
	...cornerArc(f, 1, 1, 0, 45),
];

const toPath = (points: ReadonlyArray<Point>, close: boolean) =>
	points
		.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
		.join("") + (close ? "Z" : "");

const wall = (
	edge: ReadonlyArray<readonly [number, number]>,
	base: number,
	top: number,
) =>
	toPath(
		[
			...edge.map(([x, y]) => project(x, y, top)),
			...[...edge].reverse().map(([x, y]) => project(x, y, base)),
		],
		true,
	);

/** A box with rounded corners: its top face and the two walls you can see. */
export type Slab = {
	readonly top: string;
	readonly left: string;
	readonly right: string;
	/** The near edge of the top face, for the light lip under it. */
	readonly lip: string;
	/** The footprint on the ground, for the soft shadow. */
	readonly ground: string;
};

export const slab = (f: Footprint, base: number, height: number): Slab => {
	const top = base + height;
	return {
		top: toPath(outline(f).map(([x, y]) => project(x, y, top)), true),
		left: wall(leftWallEdge(f), base, top),
		right: wall(rightWallEdge(f), base, top),
		lip: toPath(
			[...rightWallEdge(f), ...leftWallEdge(f)].map(([x, y]) => project(x, y, top)),
			false,
		),
		ground: toPath(outline(f).map(([x, y]) => project(x, y, base)), true),
	};
};

/** Screen-space bounds of a footprint from `base` up to `top`, as a viewBox. */
export const viewBoxFor = (f: Footprint, base: number, top: number, pad: number) => {
	const points = outline(f).flatMap(([x, y]) => [
		project(x, y, base),
		project(x, y, top),
	]);
	const xs = points.map(([x]) => x);
	const ys = points.map(([, y]) => y);
	const minX = Math.min(...xs) - pad;
	const minY = Math.min(...ys) - pad;
	const width = Math.max(...xs) + pad - minX;
	const height = Math.max(...ys) + pad - minY;
	return [minX, minY, width, height].map((n) => n.toFixed(2)).join(" ");
};

/** Moves plan-space shapes (a `rect`) onto a face at height `z`. */
export const planTransform = (z: number) =>
	`translate(0 ${-z}) matrix(${COS30} 0.5 ${-COS30} 0.5 0 0)`;

// VIEW

/** Gradients and blurs that every drawing on the page uses. Render once. */
export const isoDefs = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		[h.Class("absolute size-0 overflow-hidden"), h.AriaHidden(true)],
		[
			h.defs(
				[],
				[
					verticalGradient(h, "iso-wall-shade", ["black", "0"], ["black", "0.07"]),
					verticalGradient(h, "iso-top-sheen", ["white", "0.06"], ["black", "0.05"]),
					blur(h, "iso-blur-tight", "1.6", "-20%", "140%"),
					blur(h, "iso-blur-ground", "6", "-50%", "200%"),
				],
			),
		],
	);

const verticalGradient = <M>(
	h: HtmlBuilder<M>,
	id: string,
	from: readonly [color: string, opacity: string],
	to: readonly [color: string, opacity: string],
) =>
	h.linearGradient(
		[h.Id(id), h.Attribute("x1", "0"), h.Attribute("y1", "0"), h.Attribute("x2", "0"), h.Attribute("y2", "1")],
		[from, to].map(([color, opacity], index) =>
			h.stop(
				[h.Offset(String(index)), h.StopColor(color), h.StopOpacity(opacity)],
				[],
			),
		),
	);

const blur = <M>(
	h: HtmlBuilder<M>,
	id: string,
	deviation: string,
	origin: string,
	size: string,
) =>
	h.filter(
		[h.Id(id), h.X(origin), h.Y(origin), h.Width(size), h.Height(size)],
		[h.feGaussianBlur([h.Attribute("stdDeviation", deviation)], [])],
	);

export type Tone = "neutral" | "accent";

/** A slab with walls, shading, hairline edges and a sheen on top. */
export const slabView = <M>(h: HtmlBuilder<M>, s: Slab, tone: Tone): Html => {
	const path = (d: string, className: string) => h.path([h.D(d), h.Class(className)], []);
	return h.g(
		[h.Class(tone === "accent" ? "iso-accent" : "iso-neutral")],
		[
			path(s.left, "iso-wall-l"),
			path(s.right, "iso-wall-r"),
			path(s.left, "iso-shade"),
			path(s.right, "iso-shade"),
			path(s.left, "iso-edge"),
			path(s.right, "iso-edge"),
			h.path([h.D(s.lip), h.Class("iso-lip"), h.Transform("translate(0 0.9)")], []),
			path(s.top, "iso-top"),
			path(s.top, "iso-sheen"),
		],
	);
};

/** The soft shadow under a slab. */
export const groundView = <M>(h: HtmlBuilder<M>, s: Slab): Html =>
	h.path([h.D(s.ground), h.Class("iso-ground"), h.Transform("translate(0 4)")], []);

/** A rounded rectangle lying on a face at height `z`. */
export const planRect = <M>(
	h: HtmlBuilder<M>,
	f: Footprint,
	z: number,
	className: string,
): Html =>
	h.rect(
		[
			h.X(String(f.cx - f.width / 2)),
			h.Y(String(f.cy - f.depth / 2)),
			h.Width(String(f.width)),
			h.Height(String(f.depth)),
			h.Rx(String(f.radius)),
			h.Transform(planTransform(z)),
			h.Class(className),
		],
		[],
	);
