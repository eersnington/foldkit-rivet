import { DevToolsVite } from "@effect/ui-devtools/node";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** `pnpm dev:web` asks the running server for these, as the built page does. */
const SERVER_URL = "http://localhost:8080";

/** The devtools MCP server's port. The other demos use 4781 to 4783. */
const DEVTOOLS_PORT = 4780;

export default defineConfig({
	root: import.meta.dirname,
	// The devtools MCP server runs only under `vite dev`. Each demo has its own
	// port, so they never collide on the default 4774.
	plugins: [
		tailwindcss(),
		DevToolsVite.plugin({ dispatch: true, port: DEVTOOLS_PORT }),
	],
	optimizeDeps: {
		entries: ["src/entry.ts"],
	},
	server: {
		port: 8180,
		strictPort: true,
		proxy: {
			"/config.json": SERVER_URL,
			"/token": SERVER_URL,
		},
	},
});
