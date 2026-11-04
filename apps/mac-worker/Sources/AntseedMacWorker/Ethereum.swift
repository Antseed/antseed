import CryptoSwift
import Foundation
import P256K

enum EthereumError: Error {
    case invalidSignature
    case invalidHex
}

func keccak256(_ data: [UInt8]) -> [UInt8] {
    SHA3(variant: .keccak256).calculate(for: data)
}

func keccak256(_ data: Data) -> [UInt8] {
    keccak256([UInt8](data))
}

extension Data {
    init(hexString hex: String) throws {
        let clean = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
        guard clean.count % 2 == 0 else { throw EthereumError.invalidHex }
        var bytes = [UInt8]()
        bytes.reserveCapacity(clean.count / 2)
        var index = clean.startIndex
        while index < clean.endIndex {
            let next = clean.index(index, offsetBy: 2)
            guard let byte = UInt8(clean[index..<next], radix: 16) else { throw EthereumError.invalidHex }
            bytes.append(byte)
            index = next
        }
        self = Data(bytes)
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
    var prefixedHex: String { "0x" + hex }
}

/// EIP-191 personal_sign digest of a message.
func personalMessageDigest(_ message: [UInt8]) -> [UInt8] {
    keccak256(Array("\u{19}Ethereum Signed Message:\n\(message.count)".utf8) + message)
}

/// Ethereum address of an uncompressed secp256k1 public key (65 bytes, 0x04 prefix).
func ethereumAddress(uncompressedPublicKey key: Data) -> String {
    let hash = keccak256(Array(key.dropFirst()))
    return Data(hash.suffix(20)).prefixedHex
}

/// Recover the signer address of a 65-byte (r ‖ s ‖ v) signature over a 32-byte digest.
func recoverAddress(digest: [UInt8], signature: Data) throws -> String {
    guard signature.count == 65 else { throw EthereumError.invalidSignature }
    var v = Int32(signature[64])
    if v >= 27 { v -= 27 }
    guard v == 0 || v == 1 else { throw EthereumError.invalidSignature }
    let recoverable = try P256K.Recovery.ECDSASignature(compactRepresentation: signature.prefix(64), recoveryId: v)
    let key = P256K.Recovery.PublicKey(HashDigest(digest), signature: recoverable, format: .uncompressed)
    return ethereumAddress(uncompressedPublicKey: key.dataRepresentation)
}

/// The worker's Ethereum identity: its address receives payouts and signs pool messages.
struct EthereumKey {
    let privateKey: P256K.Recovery.PrivateKey
    let address: String

    init(privateKey bytes: Data) throws {
        privateKey = try P256K.Recovery.PrivateKey(dataRepresentation: bytes, format: .uncompressed)
        address = ethereumAddress(uncompressedPublicKey: privateKey.publicKey.dataRepresentation)
    }

    static func generate() throws -> (EthereumKey, Data) {
        let key = try P256K.Recovery.PrivateKey(format: .uncompressed)
        return (try EthereumKey(privateKey: key.dataRepresentation), key.dataRepresentation)
    }

    /// 65-byte r ‖ s ‖ v signature (v = 27/28) over a digest.
    func sign(digest: [UInt8]) throws -> Data {
        let signature = privateKey.signature(for: HashDigest(digest))
        let compact = try signature.compactRepresentation
        return compact.signature + Data([UInt8(compact.recoveryId) + 27])
    }

    /// EIP-191 personal_sign of a UTF-8 message, as 0x-hex.
    func personalSign(_ message: String) throws -> String {
        try sign(digest: personalMessageDigest(Array(message.utf8))).prefixedHex
    }
}
