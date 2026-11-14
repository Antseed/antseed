// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AntseedMacWorker",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AntseedMacWorker", targets: ["AntseedMacWorker"]),
    ],
    dependencies: [
        .package(url: "https://github.com/21-DOT-DEV/swift-secp256k1", exact: "0.24.0"),
        .package(url: "https://github.com/krzyzanowskim/CryptoSwift", exact: "1.10.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1"),
    ],
    targets: [
        .executableTarget(
            name: "AntseedMacWorker",
            dependencies: [
                .product(name: "P256K", package: "swift-secp256k1"),
                .product(name: "CryptoSwift", package: "CryptoSwift"),
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "AntseedMacWorkerTests",
            dependencies: ["AntseedMacWorker"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
