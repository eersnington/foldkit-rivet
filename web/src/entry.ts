import { Runtime } from "foldkit";
import {
	Flags,
	flags,
	init,
	managedResources,
	Message,
	Model,
	resources,
	subscriptions,
	update,
	view,
} from "./main.ts";

const application = Runtime.makeApplication({
	Model,
	Flags,
	init,
	update,
	view,
	subscriptions,
	resources,
	managedResources,
	container: document.getElementById("root"),
	routing: {
		onUrlRequest: (request) => Message.ClickedLink({ request }),
		onUrlChange: (url) => Message.ChangedUrl({ url }),
	},
	devTools: { Message },
});

Runtime.run(application, { flags });
