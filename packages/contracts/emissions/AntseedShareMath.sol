// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title AntseedShareMath
/// @notice Shared saturating share curve for the recognized-usage reward
///         controllers. Defining the protocol's dynamic-emission share
///         formula once keeps the buyer/seller usage shares and the staker
///         pool share on the same curve against the same gate emission.
library AntseedShareMath {
    /// @dev Share (in bps) that rises from `minShareBps` at metric 0 toward
    ///      `maxShareBps` as `metric` grows past `target`:
    ///      min + (max − min) · metric / (metric + target). Zero metric earns
    ///      nothing; a zero target saturates immediately to `maxShareBps`.
    function saturatingShareBps(uint256 metric, uint32 minShareBps, uint32 maxShareBps, uint256 target)
        internal
        pure
        returns (uint32)
    {
        if (metric == 0) return 0;
        if (target == 0) return maxShareBps;
        return uint32(uint256(minShareBps) + Math.mulDiv(maxShareBps - minShareBps, metric, metric + target));
    }
}
