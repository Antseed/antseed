import { bytesToHex, hexToBytes } from "../../../utils/hex.js";
import type { PeerField } from "../field.js";

/** [flag:1]([len:1][displayName:N])? */
export const displayNameField: PeerField = {
  keys: ["displayName"],
  encode(writer, metadata) {
    const displayName = metadata.displayName?.trim();
    if (displayName && displayName.length > 0) {
      writer.u8(1);
      writer.utf8Wrapping(displayName);
    } else {
      writer.u8(0);
    }
  },
  decode(reader, metadata) {
    if (reader.u8() === 1) metadata.displayName = reader.utf8();
  },
};

/** [flag:1]([len:1][host:port:N])? */
export const publicAddressField: PeerField = {
  keys: ["publicAddress"],
  encode(writer, metadata) {
    const publicAddress = metadata.publicAddress?.trim();
    if (publicAddress && publicAddress.length > 0) {
      writer.u8(1);
      writer.utf8Wrapping(publicAddress);
    } else {
      writer.u8(0);
    }
  },
  decode(reader, metadata) {
    if (reader.u8() === 1) metadata.publicAddress = reader.utf8();
  },
};

/**
 * [flag:1]([sellerContract:20])? — buyers verify the peer→contract binding
 * via `sellerContract.isOperator(peerAddress)`.
 */
export const sellerContractField: PeerField = {
  keys: ["sellerContract"],
  encode(writer, metadata) {
    if (metadata.sellerContract) {
      writer.u8(1);
      writer.bytes(hexToBytes(metadata.sellerContract));
    } else {
      writer.u8(0);
    }
  },
  decode(reader, metadata) {
    if (reader.u8() === 1) metadata.sellerContract = bytesToHex(reader.bytes(20));
  },
};
