/** A released Antseed TEE seller image (ghcr.io/antseed/tee-seller), by manifest digest. */
export interface ApprovedSellerImage {
  /** The @antseed/cli version the image runs; shown in claim details. */
  version: string
  /** "sha256:<64 hex>" */
  digest: string
}

/**
 * Antseed TEE seller images approved by digest. Images the "Publish TEE seller image" workflow
 * builds from main are approved by their build record instead (image-provenance.ts); this list
 * holds images approved before that, and buyers can add their own (ANTSEED_VERIFIER_NODE_BUILDS).
 */
export const APPROVED_SELLER_IMAGES: readonly ApprovedSellerImage[] = [
  { version: '0.1.234', digest: 'sha256:74972a3ce21531fcfc4bdd48a3cac95d20afe39f234cb7c472fae2e004e605bc' },
]

/**
 * Image digests no longer accepted, whether listed above or approved by their build record. To
 * retire every image built before a date at once, raise IMAGES_BUILT_AFTER in image-provenance.ts.
 */
export const REVOKED_SELLER_IMAGES: readonly string[] = []
