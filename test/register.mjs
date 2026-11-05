// Maps the specifiers a Herdr mod imports (gpui-kit, gpui-base, herdr, fs/promises) to the mocks next to this file.
// Tests that want the real file system import "node:fs/promises", which is not mapped.
import * as nodeModule from "node:module";

const MOCKS = {
  "gpui-kit": new URL("./mocks/gpui-kit.mjs", import.meta.url).href,
  "gpui-base": new URL("./mocks/gpui-base.mjs", import.meta.url).href,
  herdr: new URL("./mocks/herdr.mjs", import.meta.url).href,
  "fs/promises": new URL("./mocks/fs.mjs", import.meta.url).href,
};

// module.register() is deprecated on current node; registerHooks() runs the same resolve hook in-thread.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier in MOCKS ? { url: MOCKS[specifier], shortCircuit: true } : nextResolve(specifier, context);
    },
  });
} else {
  nodeModule.register("./hooks.mjs", import.meta.url);
}
