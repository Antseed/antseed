// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AntseedLegacyEmissionsRegistry } from "../emissions/AntseedLegacyEmissionsRegistry.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";

interface ILegacyEmissionsV2 {
    function registry() external view returns (address);
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function currentEpoch() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
    function userSellerPoints(address seller, uint256 epoch) external view returns (uint256);
    function userBuyerPoints(address buyer, uint256 epoch) external view returns (uint256);
    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
    function accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta) external;
    function claimSellerEmissions(uint256[] calldata epochs) external;
    function claimBuyerEmissions(address buyer, uint256[] calldata epochs) external;
    function flushReserve() external;
    function flushTeam() external;
    function setRegistry(address registry) external;
    function renounceOwnership() external;
}

interface IAntseedDepositsOperator {
    function getOperator(address buyer) external view returns (address);
}

interface IRegistryAdmin {
    function owner() external view returns (address);
    function setChannels(address channels) external;
}

contract AntseedLegacyEmissionsRegistryTest is Test {
    address internal constant ESCROW_STUB = address(0xE5);
    address internal constant DEPOSITS_STUB = address(0xD1);

    function test_constructor_revert_zeroAddresses() public {
        vm.expectRevert(AntseedLegacyEmissionsRegistry.InvalidAddress.selector);
        new AntseedLegacyEmissionsRegistry(address(0), DEPOSITS_STUB);
        vm.expectRevert(AntseedLegacyEmissionsRegistry.InvalidAddress.selector);
        new AntseedLegacyEmissionsRegistry(ESCROW_STUB, address(0));
    }

    function test_getters() public {
        AntseedLegacyEmissionsRegistry reg = new AntseedLegacyEmissionsRegistry(ESCROW_STUB, DEPOSITS_STUB);
        assertEq(reg.channels(), address(0));
        assertEq(reg.antsToken(), ESCROW_STUB);
        assertEq(reg.deposits(), DEPOSITS_STUB);
        assertEq(reg.protocolReserve(), address(0));
        assertEq(reg.teamWallet(), address(0));
    }
}

/// @notice Runs against Base mainnet. Returns early without
///         BASE_MAINNET_RPC_URL, so a green run without it proves nothing.
contract AntseedLegacyEmissionsRegistryForkTest is Test {
    address internal constant MAIN_REGISTRY = 0xf33fC901BFa97326379A369401F4490E231B69B0;
    address internal constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    address internal constant CHANNELS = 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d;
    address internal constant DEPOSITS = 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2;
    address internal constant LEGACY_EMISSIONS_V2 = 0xF13bE52c4A3afC6AE29536f073588d01A0564088;
    address internal constant ESCROW = 0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab;

    bytes4 internal constant NOT_AUTHORIZED = bytes4(keccak256("NotAuthorized()"));
    bytes4 internal constant NO_PROTOCOL_RESERVE = bytes4(keccak256("NoProtocolReserve()"));
    bytes4 internal constant NO_TEAM_WALLET = bytes4(keccak256("NoTeamWallet()"));

    ILegacyEmissionsV2 internal v2 = ILegacyEmissionsV2(LEGACY_EMISSIONS_V2);
    IERC20 internal ants = IERC20(ANTS_TOKEN);

    address internal seller = makeAddr("forkSeller");
    address internal buyer = makeAddr("forkBuyer");
    address internal operator = makeAddr("forkOperator");

    function testFork_baselineGateIsOpenThroughEscrow() public {
        if (!_selectFork()) return;

        assertEq(v2.registry(), ESCROW);
        assertEq(IAntseedRegistry(ESCROW).antsToken(), ESCROW);
        assertEq(IAntseedRegistry(ESCROW).channels(), CHANNELS);
        assertEq(IAntseedRegistry(ESCROW).deposits(), DEPOSITS);
        assertFalse(v2.paused());

        // Today the live Channels address can still add V2 points.
        uint256 epoch = v2.currentEpoch();
        vm.prank(CHANNELS);
        v2.accrueSellerPoints(seller, 1e6);
        assertEq(v2.userSellerPoints(seller, epoch), 1e6);
    }

    function testFork_pinnedRegistryStopsEveryAccrual() public {
        if (!_selectFork()) return;
        AntseedLegacyEmissionsRegistry pinned = _pin();

        vm.startPrank(CHANNELS);
        vm.expectRevert(NOT_AUTHORIZED);
        v2.accrueSellerPoints(seller, 1e6);
        vm.expectRevert(NOT_AUTHORIZED);
        v2.accrueBuyerPoints(buyer, 1e6);
        vm.expectRevert(NOT_AUTHORIZED);
        v2.accruePoints(bytes32(0), buyer, seller, 1e6);
        vm.stopPrank();

        // Re-pointing the main registry's channels no longer reaches V2.
        address attacker = makeAddr("newChannels");
        IRegistryAdmin main = IRegistryAdmin(MAIN_REGISTRY);
        vm.prank(main.owner());
        main.setChannels(attacker);
        vm.prank(attacker);
        vm.expectRevert(NOT_AUTHORIZED);
        v2.accrueSellerPoints(seller, 1e6);

        assertEq(pinned.channels(), address(0));
    }

    function testFork_earnedEpochsStayClaimable() public {
        if (!_selectFork()) return;

        // Earn points in the current epoch through the live gate.
        uint256 epoch = v2.currentEpoch();
        vm.startPrank(CHANNELS);
        v2.accrueSellerPoints(seller, 1e12);
        v2.accrueBuyerPoints(buyer, 1e12);
        vm.stopPrank();

        vm.warp(block.timestamp + v2.EPOCH_DURATION());
        assertGt(v2.currentEpoch(), epoch);

        _pin();
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = epoch;

        // Seller: paid by the escrow, either directly or locked in the pool.
        uint256 escrowBefore = ants.balanceOf(ESCROW);
        vm.prank(seller);
        v2.claimSellerEmissions(epochs);
        uint256 sellerPaid = escrowBefore - ants.balanceOf(ESCROW);
        assertGt(sellerPaid, 0);

        // Buyer: the pinned deposits() answers the operator check.
        vm.mockCall(
            DEPOSITS, abi.encodeCall(IAntseedDepositsOperator.getOperator, (buyer)), abi.encode(operator)
        );
        escrowBefore = ants.balanceOf(ESCROW);
        vm.prank(operator);
        v2.claimBuyerEmissions(buyer, epochs);
        uint256 buyerPaid = escrowBefore - ants.balanceOf(ESCROW);
        assertGt(buyerPaid, 0);
        assertEq(ants.balanceOf(operator), buyerPaid);
    }

    function testFork_flushesCanNeverPay() public {
        if (!_selectFork()) return;
        _pin();

        // The owner-only flushes revert on an empty accumulator or a zero
        // destination; either way nothing leaves the escrow.
        address owner = v2.owner();
        uint256 escrowBefore = ants.balanceOf(ESCROW);
        vm.startPrank(owner);
        vm.expectRevert();
        v2.flushReserve();
        vm.expectRevert();
        v2.flushTeam();
        vm.stopPrank();
        assertEq(ants.balanceOf(ESCROW), escrowBefore);
    }

    function testFork_renouncedV2CannotLeaveThePinnedRegistry() public {
        if (!_selectFork()) return;
        AntseedLegacyEmissionsRegistry pinned = _pin();

        vm.prank(v2.owner());
        v2.renounceOwnership();
        assertEq(v2.owner(), address(0));

        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        v2.setRegistry(ESCROW);
        assertEq(v2.registry(), address(pinned));
    }

    function _pin() private returns (AntseedLegacyEmissionsRegistry pinned) {
        pinned = new AntseedLegacyEmissionsRegistry(ESCROW, DEPOSITS);
        vm.prank(v2.owner());
        v2.setRegistry(address(pinned));
        assertEq(v2.registry(), address(pinned));
    }

    function _selectFork() private returns (bool) {
        string memory rpcUrl = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;

        uint256 forkBlock = vm.envOr("BASE_MAINNET_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
        return true;
    }
}
