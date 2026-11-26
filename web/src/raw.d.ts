/** Vite gives the text of a file for an import that ends in `?raw`. */
declare module "*?raw" {
	const source: string;
	export default source;
}
