/** A released Antseed TEE seller image (ghcr.io/antseed/tee-seller), by manifest digest. */
export interface ApprovedSellerImage {
  /** The @antseed/cli version the image runs; shown in claim details. */
  version: string
  /** "sha256:<64 hex>" */
  digest: string
}

/**
 * Antseed TEE seller images built by the "Publish TEE seller image" workflow from a locked
 * deploy/tee-seller commit. The workflow opens the pull request that adds each new image here
 * (deploy/tee-seller/approve-image.mjs); keep one entry per line.
 */
export const APPROVED_SELLER_IMAGES: readonly ApprovedSellerImage[] = [
  { version: '0.1.234', digest: 'sha256:74972a3ce21531fcfc4bdd48a3cac95d20afe39f234cb7c472fae2e004e605bc' },
]
