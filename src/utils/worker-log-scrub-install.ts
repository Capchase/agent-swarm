import { installConsoleScrub } from "./console-scrub";

// Install before dependency/module-load logs. Interactive and protocol CLI
// commands retain their stdout semantics.
if (process.argv[2] === "worker" || process.argv[2] === "lead") {
  installConsoleScrub({ streams: true });
}
