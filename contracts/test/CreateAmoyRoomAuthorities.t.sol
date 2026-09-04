// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CreateAmoyRoom} from "../script/CreateAmoyRoom.s.sol";
import {LiveRoom} from "../src/LiveRoom.sol";

/// The deploy script's authority-separation check, which nothing exercised.
///
/// `CreateAmoyRoom` is the only tool that stands between an operator and a room
/// whose authorities are the same key. Its own header says it "refuses to do
/// it" — but the refusal was never tested, and it did not cover the integrity
/// adjudicator at all. That key alone can uphold an Integrity Claim, which
/// moves a participant's entire 100 USDC Integrity Bond to the bond recipient
/// and hands the claimant their 10 USDC back. An adjudicator that is also a
/// resolver decides the market AND seizes the bond; an adjudicator that is also
/// the gate signer gates the market AND seizes the bond. Neither is a
/// configuration anyone would choose on purpose, and both used to deploy.
contract CreateAmoyRoomAuthoritiesTest is Test {
    Harness internal harness;

    address constant GATE = address(0xA1);
    address constant PUBLISHER = address(0xA2);
    address constant ADJUDICATOR = address(0xA3);
    address constant R1 = address(0xB1);
    address constant R2 = address(0xB2);
    address constant R3 = address(0xB3);

    function setUp() public {
        harness = new Harness();
    }

    /// A configuration where every authority is its own address is accepted.
    function test_distinctAuthoritiesAreAccepted() public view {
        harness.check(_config());
    }

    function test_rejectsGateEqualToPublisher() public {
        LiveRoom.RoomConfig memory config = _config();
        config.publisher = GATE;
        vm.expectRevert();
        harness.check(config);
    }

    function test_rejectsRepeatedResolver() public {
        LiveRoom.RoomConfig memory config = _config();
        config.resolvers[2] = R1;
        vm.expectRevert();
        harness.check(config);
    }

    function test_rejectsResolverEqualToGateOrPublisher() public {
        LiveRoom.RoomConfig memory config = _config();
        config.resolvers[0] = GATE;
        vm.expectRevert();
        harness.check(config);

        config = _config();
        config.resolvers[1] = PUBLISHER;
        vm.expectRevert();
        harness.check(config);
    }

    /// The adjudicator holds the bond-seizing power. Sharing it with the key
    /// that gates the room, publishes into it, or attests its results collapses
    /// a separation that no later check restores: `LiveRoom.initialize` does not
    /// re-derive it, and nothing at runtime notices.
    function test_rejectsAdjudicatorEqualToGate() public {
        LiveRoom.RoomConfig memory config = _config();
        config.integrityAdjudicator = GATE;
        vm.expectRevert();
        harness.check(config);
    }

    function test_rejectsAdjudicatorEqualToPublisher() public {
        LiveRoom.RoomConfig memory config = _config();
        config.integrityAdjudicator = PUBLISHER;
        vm.expectRevert();
        harness.check(config);
    }

    function test_rejectsAdjudicatorEqualToAnyResolver() public {
        for (uint256 i = 0; i < 3; i++) {
            LiveRoom.RoomConfig memory config = _config();
            config.integrityAdjudicator = config.resolvers[i];
            vm.expectRevert();
            harness.check(config);
        }
    }

    /// The adjudicator decides whether the bond is forfeited; the recipient
    /// receives it. One key holding both decides to pay itself.
    function test_rejectsAdjudicatorEqualToBondRecipient() public {
        LiveRoom.RoomConfig memory config = _config();
        config.integrityAdjudicator = config.bondRecipient;
        vm.expectRevert();
        harness.check(config);
    }

    /// A participant who can rule on integrity claims can clear a claim against
    /// themselves, or uphold one against their opponent.
    function test_rejectsAdjudicatorEqualToAParticipant() public {
        LiveRoom.RoomConfig memory config = _config();
        config.integrityAdjudicator = config.participantA;
        vm.expectRevert();
        harness.check(config);

        config = _config();
        config.integrityAdjudicator = config.participantB;
        vm.expectRevert();
        harness.check(config);
    }

    function _config() internal pure returns (LiveRoom.RoomConfig memory config) {
        config.gateSigner = GATE;
        config.publisher = PUBLISHER;
        config.integrityAdjudicator = ADJUDICATOR;
        config.participantA = address(0xC1);
        config.participantB = address(0xC2);
        config.rewardAddressA = address(0xC1);
        config.rewardAddressB = address(0xC2);
        config.bondRecipient = address(0xD1);
        config.resolvers = [R1, R2, R3];
    }
}

/// `_requireDistinctAuthorities` is internal, and it is internal for a reason —
/// it is a precondition of `run()`, not a public API. Inheriting is how a test
/// reaches it without widening the script's surface.
contract Harness is CreateAmoyRoom {
    function check(LiveRoom.RoomConfig memory config) external pure {
        _requireDistinctAuthorities(config);
    }
}
