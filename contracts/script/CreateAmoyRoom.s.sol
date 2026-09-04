// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";

/// Creates one Live Room on Polygon Amoy.
///
/// The factory and implementations are deployed by DeployAmoy; this is the room
/// itself — the thing the Coordinator serves and the operators drive. It is
/// separate because a deployment creates many rooms over time and should not
/// redeploy the factory to do it.
///
/// Every authority is a distinct address on purpose. The gate signs permits,
/// the publisher publishes, the adjudicator rules on integrity claims, and the
/// three resolvers attest independently. Passing one key for several of them
/// would compile and run, and would quietly collapse the separation the whole
/// design rests on — so this refuses to do it.
contract CreateAmoyRoom is Script {
    error DuplicateAuthority(string which);

    function run() external returns (address room) {
        uint256 creatorKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        LiveMarketFactory factory = LiveMarketFactory(vm.envAddress("FACTORY_ADDRESS"));

        LiveRoom.RoomConfig memory config;
        config.roomId = bytes32(bytes(vm.envString("ROOM_ID")));
        config.headlineTemplateId = bytes32(bytes(vm.envOr("HEADLINE_TEMPLATE_ID", string("tpl-participant-v1"))));
        config.gateSigner = vm.envAddress("GATE_SIGNER");
        config.publisher = vm.envAddress("PUBLISHER");
        config.integrityAdjudicator = vm.envAddress("INTEGRITY_ADJUDICATOR");
        config.participantA = vm.envAddress("PARTICIPANT_A");
        config.participantB = vm.envAddress("PARTICIPANT_B");
        config.rewardAddressA = vm.envOr("REWARD_ADDRESS_A", config.participantA);
        config.rewardAddressB = vm.envOr("REWARD_ADDRESS_B", config.participantB);
        config.bondRecipient = vm.envAddress("BOND_RECIPIENT");
        config.liquidityRouter = vm.envOr("LIQUIDITY_ROUTER", address(0));
        config.resolvers = [vm.envAddress("RESOLVER_1"), vm.envAddress("RESOLVER_2"), vm.envAddress("RESOLVER_3")];

        config.epochDuration = uint64(vm.envOr("EPOCH_DURATION_S", uint256(60)));
        config.sourceFinalityDelay = uint64(vm.envOr("SOURCE_FINALITY_DELAY_S", uint256(15)));
        config.maxPendingTime = uint64(vm.envOr("MAX_PENDING_TIME_S", uint256(900)));
        config.challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW_S", uint256(600)));
        config.challengeTimeout = uint64(vm.envOr("CHALLENGE_TIMEOUT_S", uint256(1800)));
        config.minAnnounceDelay = uint64(vm.envOr("ANNOUNCE_DELAY_S", uint256(30)));
        config.maxPermitLifetime = uint64(vm.envOr("MAX_PERMIT_LIFETIME_S", uint256(300)));
        config.integrityClaimWindow = uint64(vm.envOr("INTEGRITY_CLAIM_WINDOW_S", uint256(3600)));
        config.integrityClaimTimeout = uint64(vm.envOr("INTEGRITY_CLAIM_TIMEOUT_S", uint256(3600)));
        // Permissionless recovery if the gate key is ever lost. Without it,
        // every bond, LP position and Outcome Position in the room is trapped.
        config.gateStallTimeout = uint64(vm.envOr("GATE_STALL_TIMEOUT_S", uint256(21600)));
        config.maxOpenSlots = uint32(vm.envOr("MAX_OPEN_SLOTS", uint256(4)));
        config.participantAName = vm.envString("PARTICIPANT_A_NAME");
        config.participantBName = vm.envString("PARTICIPANT_B_NAME");

        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](3);
        templates[0] = LiveRoom.TemplateRule(bytes32(bytes("tpl-participant-v1")), 100);
        templates[1] = LiveRoom.TemplateRule(bytes32(bytes("tpl-threshold-v1")), 0);
        templates[2] = LiveRoom.TemplateRule(bytes32(bytes("tpl-race-v1")), 100);
        config.templates = templates;

        // The participants themselves, and anyone else the operator names.
        // Restricting an insider's wallet is the point of the list, so the two
        // competitors are on it by construction.
        address[] memory restricted = new address[](2);
        restricted[0] = config.participantA;
        restricted[1] = config.participantB;
        config.restrictedWallets = restricted;

        _requireDistinctAuthorities(config);

        vm.startBroadcast(creatorKey);
        room = factory.createRoom(config);
        vm.stopBroadcast();

        console2.log("Live Room", room);
        console2.log("Room id", vm.envString("ROOM_ID"));
        console2.log("Gate signer", config.gateSigner);
        console2.log("Publisher", config.publisher);
        console2.log("Resolvers", config.resolvers[0], config.resolvers[1], config.resolvers[2]);
    }

    /// Publication needs the publisher role AND a gate signature; a resolver
    /// quorum needs two resolvers who are not each other. One key holding two
    /// of these makes the pair meaningless, so it is rejected here rather than
    /// discovered later.
    function _requireDistinctAuthorities(LiveRoom.RoomConfig memory config) internal pure {
        if (config.gateSigner == config.publisher) revert DuplicateAuthority("gate signer and publisher");
        if (
            config.resolvers[0] == config.resolvers[1] || config.resolvers[1] == config.resolvers[2]
                || config.resolvers[0] == config.resolvers[2]
        ) {
            revert DuplicateAuthority("resolvers must be three different addresses");
        }
        for (uint256 i = 0; i < 3; i++) {
            if (config.resolvers[i] == config.gateSigner) revert DuplicateAuthority("resolver and gate signer");
            if (config.resolvers[i] == config.publisher) revert DuplicateAuthority("resolver and publisher");
        }

        // The adjudicator was checked against nothing at all, though the header
        // above has always claimed otherwise. It is the one key that can uphold
        // an Integrity Claim, which moves a participant's whole 100 USDC bond to
        // the bond recipient. Sharing it with any other role is a configuration
        // nobody chooses deliberately, and no later check catches it:
        // `LiveRoom.initialize` does not re-derive the separation and nothing at
        // runtime notices, so the room simply operates with one key holding two
        // powers that were meant to constrain each other.
        address adjudicator = config.integrityAdjudicator;
        if (adjudicator == config.gateSigner) revert DuplicateAuthority("adjudicator and gate signer");
        if (adjudicator == config.publisher) revert DuplicateAuthority("adjudicator and publisher");
        for (uint256 i = 0; i < 3; i++) {
            if (adjudicator == config.resolvers[i]) revert DuplicateAuthority("adjudicator and resolver");
        }
        // Deciding the forfeiture and receiving it must not be the same key.
        if (adjudicator == config.bondRecipient) revert DuplicateAuthority("adjudicator and bond recipient");
        // A competitor who rules on integrity claims can clear one against
        // themselves and uphold one against the other side.
        if (adjudicator == config.participantA || adjudicator == config.participantB) {
            revert DuplicateAuthority("adjudicator and participant");
        }
    }
}
