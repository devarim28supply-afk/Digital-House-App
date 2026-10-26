import { render } from "solid-js/web";

import { App } from "./App";

import "./styles.css";
import "./ui/layout-themes.css";
import "./data/layoutTheme";

render(() => <App />, document.getElementById("root")!);
