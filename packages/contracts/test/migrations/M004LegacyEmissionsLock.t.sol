// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { M004LockLegacyEmissions } from "../../script/migrations/M004LegacyEmissionsLock/Lock.s.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";

interface IM004V2 {
    function owner() external view returns (address);
    function registry() external view returns (address);
    function currentEpoch() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
    function sellerRewardsPool() external view returns (address);
    function sellerUnlockPolicy() external view returns (address);
    function legacyEmissions() external view returns (address);
    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function claimSellerEmissions(uint256[] calldata epochs) external;
    function pause() external;
}

interface IM004Owned {
    function owner() external view returns (address);
}

interface IM004Pool {
    function setSellerClaimPolicy(address policy) external;
}

interface IM004SetRegistry {
    function setRegistry(address registry) external;
}

interface IM004Escrow {
    function sweep(address recipient) external returns (uint256);
}

interface IM004Registry {
    function channels() external view returns (address);
}

/// @notice Drives Lock.s.sol against Base mainnet. Returns early without
///         BASE_MAINNET_RPC_URL, so a green run without it proves nothing.
contract M004LegacyEmissionsLockForkTest is Test {
    address internal constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    address internal constant CHANNELS = 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d;
    address internal constant DEPOSITS = 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2;
    address internal constant LEGACY_EMISSIONS_V2 = 0xF13bE52c4A3afC6AE29536f073588d01A0564088;
    address internal constant ESCROW = 0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab;
    address internal constant CLAIM_POLICY = 0xB3ae8460481976Ad996EaFf71715c7bAeFb1D829;

    IM004V2 internal v2 = IM004V2(LEGACY_EMISSIONS_V2);
    M004LockLegacyEmissions internal script;
    address internal seller = makeAddr("m004Seller");

    function testFork_lockPinsRenouncesAndKeepsClaims() public {
        if (!_selectFork()) return;
        address owner = v2.owner();
        address pool = v2.sellerRewardsPool();
        address unlockPolicy = v2.sellerUnlockPolicy();
        address v1 = v2.legacyEmissions();

        // Points earned before the lock stay claimable after it.
        uint256 epoch = v2.currentEpoch();
        vm.prank(CHANNELS);
        v2.accrueSellerPoints(seller, 1e12);
        vm.warp(block.timestamp + v2.EPOCH_DURATION());

        address pinned = script.runWith(_config(owner));

        assertEq(v2.registry(), pinned);
        assertEq(IM004Registry(pinned).channels(), address(0));
        assertEq(v2.owner(), address(0));
        assertEq(IM004Owned(pool).owner(), address(0));
        assertEq(IM004Owned(unlockPolicy).owner(), address(0));
        assertEq(IM004Owned(v1).owner(), address(0));
        assertEq(IM004Owned(ESCROW).owner(), address(0));

        // Nobody can sweep the escrow any more, not even the former owner.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", owner));
        IM004Escrow(ESCROW).sweep(owner);

        vm.prank(CHANNELS);
        vm.expectRevert(bytes4(keccak256("NotAuthorized()")));
        v2.accrueSellerPoints(seller, 1e12);

        uint256[] memory epochs = new uint256[](1);
        epochs[0] = epoch;
        uint256 escrowBefore = IERC20(ANTS_TOKEN).balanceOf(ESCROW);
        vm.prank(seller);
        v2.claimSellerEmissions(epochs);
        assertLt(IERC20(ANTS_TOKEN).balanceOf(ESCROW), escrowBefore);
    }

    function testFork_rerunIsANoOp() public {
        if (!_selectFork()) return;
        address owner = v2.owner();
        address pinned = script.runWith(_config(owner));

        vm.recordLogs();
        assertEq(script.runWith(_config(owner)), pinned);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function testFork_refusesWrongOwner() public {
        if (!_selectFork()) return;
        vm.expectRevert("EmissionsV2 is not owned by LEGACY_OWNER");
        script.runWith(_config(makeAddr("stranger")));
    }

    function testFork_refusesPausedV2() public {
        if (!_selectFork()) return;
        address owner = v2.owner();
        vm.prank(owner);
        v2.pause();
        vm.expectRevert("EmissionsV2 is paused: renouncing would freeze every claim");
        script.runWith(_config(owner));
    }

    function testFork_refusesWrongDeposits() public {
        if (!_selectFork()) return;
        M004LockLegacyEmissions.Config memory cfg = _config(v2.owner());
        cfg.deposits = makeAddr("otherDeposits");
        vm.expectRevert("EXPECTED_DEPOSITS is not the live Deposits");
        script.runWith(cfg);
    }

    function testFork_refusesAReplacedClaimPolicy() public {
        if (!_selectFork()) return;
        address owner = v2.owner();
        address pool = v2.sellerRewardsPool();
        vm.prank(owner);
        IM004Pool(pool).setSellerClaimPolicy(makeAddr("zeroPayingPolicy"));

        vm.expectRevert("rewards pool claim policy is not the recorded M002 policy");
        script.runWith(_config(owner));
        assertEq(IM004Owned(pool).owner(), owner);
    }

    function testFork_refusesAMutableRegistryWithMatchingAnswers() public {
        if (!_selectFork()) return;
        address owner = v2.owner();
        // Answers zero Channels, the escrow and the live Deposits today, but keeps an owner.
        AntseedRegistry mutableRegistry = new AntseedRegistry();
        mutableRegistry.setAntsToken(ESCROW);
        mutableRegistry.setDeposits(DEPOSITS);
        vm.prank(owner);
        IM004SetRegistry(LEGACY_EMISSIONS_V2).setRegistry(address(mutableRegistry));

        vm.expectRevert("EmissionsV2 registry is not the AntseedLegacyEmissionsRegistry");
        script.runWith(_config(owner));
        assertEq(v2.owner(), owner);
    }

    function _config(address owner) private pure returns (M004LockLegacyEmissions.Config memory) {
        return M004LockLegacyEmissions.Config({
            owner: owner,
            v2: LEGACY_EMISSIONS_V2,
            escrow: ESCROW,
            antsToken: ANTS_TOKEN,
            deposits: DEPOSITS,
            claimPolicy: CLAIM_POLICY
        });
    }

    function _selectFork() private returns (bool) {
        string memory rpcUrl = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;
        uint256 forkBlock = vm.envOr("BASE_MAINNET_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpcUrl);
        else vm.createSelectFork(rpcUrl, forkBlock);
        script = new M004LockLegacyEmissions();
        return true;
    }
}
