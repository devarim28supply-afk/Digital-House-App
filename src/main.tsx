import "./data/appStyle"; // first: sets the style before anything reads it
import { render } from "solid-js/web";

import { App } from "./App";

import "./styles.css";
import "./ui/layout-themes.css";
import "./ui/mobile-layout.css";
import "./data/layoutTheme";
import "./data/mobileViewport";
import "./data/noZoom";
import "./ui/style-noir.css";
import "./ui/dialogs.css";

render(() => <App />, document.getElementById("root")!);
