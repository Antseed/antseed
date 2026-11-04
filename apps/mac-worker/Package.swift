// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AntseedMacWorker",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AntseedMacWorker", targets: ["AntseedMacWorker"]),
    ],
    dependencies: [
        // 3.31.4 / mlx-swift 0.31.4: the newest pair whose manifests build with Xcode 26.3 (Swift 6.2).
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.31.4"),
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.31.4"),
        .package(url: "https://github.com/huggingface/swift-huggingface", exact: "1.0.0"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.4.0"),
        .package(url: "https://github.com/21-DOT-DEV/swift-secp256k1", exact: "0.24.0"),
        .package(url: "https://github.com/krzyzanowskim/CryptoSwift", exact: "1.10.0"),
    ],
    targets: [
        .executableTarget(
            name: "AntseedMacWorker",
            dependencies: [
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
                .product(name: "HuggingFace", package: "swift-huggingface"),
                .product(name: "Tokenizers", package: "swift-transformers"),
                .product(name: "P256K", package: "swift-secp256k1"),
                .product(name: "CryptoSwift", package: "CryptoSwift"),
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
