// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Readiness is a statement about Participant commitment, delegated by a
///         room-bound market to its LiveRoom. Deliberately separate from gating.
interface IRoomReadiness {
    function participantsReady() external view returns (bool);
}
