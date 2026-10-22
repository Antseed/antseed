// Pages Functions bundle .wasm imports as precompiled modules (Workers can't compile WebAssembly at runtime).
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
