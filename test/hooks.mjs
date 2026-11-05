// The async resolve hook for node versions that only have module.register() (see register.mjs).
const MOCKS = {
  "gpui-kit": new URL("./mocks/gpui-kit.mjs", import.meta.url).href,
  "gpui-base": new URL("./mocks/gpui-base.mjs", import.meta.url).href,
  herdr: new URL("./mocks/herdr.mjs", import.meta.url).href,
  "fs/promises": new URL("./mocks/fs.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  return specifier in MOCKS ? { url: MOCKS[specifier], shortCircuit: true } : nextResolve(specifier, context);
}
