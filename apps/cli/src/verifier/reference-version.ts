/**
 * Version of Antseed's reference builder (`model-reference.ts`). Reference generation, bank
 * validation (`probe-bank.ts`) and the verifier compat fingerprint read this one constant, so they
 * change together. A dependency-free module: the builder imports the bank module, so the bank module
 * cannot import the builder.
 */
export const REFERENCE_BUILDER_VERSION = '7'
