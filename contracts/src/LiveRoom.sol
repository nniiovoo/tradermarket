// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LivePredictionMarket} from "./LivePredictionMarket.sol";
import {LiveMarketFactory} from "./LiveMarketFactory.sol";
import {IRoomReadiness} from "./interfaces/IRoomReadiness.sol";

/// @title LiveRoom
/// @notice One Live Session's on-chain room: publishes Market Slots under dual
///         authority (Program Publisher role + Source Gate Publication Permit),
///         batches source gating across open slots with isolated child failure,
///         and holds the Participants' room-scoped Integrity Bonds.
/// @dev Deployed as an EIP-1167 clone. Holds no Forecaster collateral: the only
///      balances here are Integrity Bonds and integrity-claim bonds.
contract LiveRoom is IRoomReadiness, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_BATCH = 16;
    /// Bounded stipend for GATING calls, whose cost is small and predictable.
    uint256 public constant CHILD_CALL_GAS = 500_000;
    /// Gas held back so the batch loop can always finish and emit its events.
    uint256 public constant BATCH_GAS_RESERVE = 60_000;
    /// Floor below which executing actions is pointless; the call is skipped
    /// and reported rather than half-run.
    uint256 public constant MIN_PROCESS_GAS = 120_000;
    uint256 public constant ROOM_INTEGRITY_BOND = 100e6;
    uint256 public constant INTEGRITY_CLAIM_BOND = 10e6;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("TraderMarket LiveRoom");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant PERMIT_TYPEHASH = keccak256(
        "PublicationPermit(address room,uint32 slotIndex,bytes32 requestHash,bytes32 conditionHash,uint256 undecidedThroughSequence,uint64 announceDelay,uint64 issuedAt,uint64 expiresAt,uint256 nonce)"
    );

    struct TemplateRule {
        bytes32 templateId;
        uint16 winnerRewardBps;
    }

    struct RoomConfig {
        bytes32 roomId;
        bytes32 headlineTemplateId;
        address gateSigner;
        address publisher;
        address integrityAdjudicator;
        address participantA;
        address participantB;
        address rewardAddressA;
        address rewardAddressB;
        address bondRecipient;
        address liquidityRouter;
        address[3] resolvers;
        uint64 epochDuration;
        uint64 sourceFinalityDelay;
        uint64 maxPendingTime;
        uint64 challengeWindow;
        uint64 challengeTimeout;
        uint64 minAnnounceDelay;
        uint64 maxPermitLifetime;
        uint64 integrityClaimWindow;
        uint64 integrityClaimTimeout;
        /// How long the room may go without any gate action before ANYONE may
        /// close it. Without this a lost gate key traps every bond, LP position,
        /// and Outcome Position in the room forever.
        uint64 gateStallTimeout;
        uint32 maxOpenSlots;
        string participantAName;
        string participantBName;
        TemplateRule[] templates;
        address[] restrictedWallets;
    }

    struct SlotRequest {
        bytes32 templateId;
        bytes32 templateParamsHash;
        bytes32 conditionHash;
        uint64 announceDelay;
        uint16 winnerRewardBps;
        string question;
        string streamUrl;
        string imageUrl;
    }

    struct PublicationPermit {
        uint32 slotIndex;
        /// Canonical hash of the COMPLETE slot request plus its restricted list.
        bytes32 requestHash;
        bytes32 conditionHash;
        uint256 undecidedThroughSequence;
        uint64 announceDelay;
        /// When the gate signed. Permit age is measured from here, never from
        /// expiry.
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 nonce;
    }

    enum ClaimStatus {
        Open,
        Upheld,
        Rejected,
        Expired
    }

    struct IntegrityClaim {
        address claimant;
        address participant;
        bytes32 violationCode;
        bytes32 evidenceHash;
        uint64 filedAt;
        ClaimStatus status;
    }

    LiveMarketFactory public factory;
    IERC20 public collateral;
    bytes32 public roomId;
    bytes32 public headlineTemplateId;
    address public gateSigner;
    address public publisher;
    address public integrityAdjudicator;
    address public participantA;
    address public participantB;
    address public rewardAddressA;
    address public rewardAddressB;
    address public bondRecipient;
    address public liquidityRouter;
    address[3] public resolvers;
    uint64 public epochDuration;
    uint64 public sourceFinalityDelay;
    uint64 public maxPendingTime;
    uint64 public challengeWindow;
    uint64 public challengeTimeout;
    uint64 public minAnnounceDelay;
    uint64 public maxPermitLifetime;
    uint64 public integrityClaimWindow;
    uint64 public integrityClaimTimeout;
    uint64 public gateStallTimeout;
    uint32 public maxOpenSlots;
    string public participantAName;
    string public participantBName;
    bool private _initialized;

    mapping(bytes32 => uint16) private _templateReward;
    mapping(bytes32 => bool) private _templateApproved;
    address[] private _restricted;

    address[] private _slots;
    mapping(address => bool) public isSlot;
    address[] private _openSlots;
    mapping(address => uint256) private _openIndexPlusOne;

    uint256 public lastObservedSequence;
    uint256 public roomClosedSequence;
    uint64 public roomClosedAt;
    /// Refreshed by every gate action. The stall recovery is measured from here.
    uint64 public lastGateActivityAt;
    bool public closedByStall;
    mapping(uint256 => bool) public usedNonce;

    mapping(address => uint256) public integrityBondOf;
    mapping(address => bool) public integrityBondClaimed;
    IntegrityClaim[] private _claims;
    mapping(address => uint256) public openClaimsAgainst;

    event SlotPublished(
        address indexed market,
        uint32 indexed slotIndex,
        bytes32 indexed templateId,
        bytes32 requestHash,
        bytes32 conditionHash,
        uint256 nonce,
        uint256 undecidedThroughSequence,
        uint64 opensAt
    );
    event SlotCallSkipped(address indexed market, uint64 indexed epoch, bytes4 selector, bytes reason);
    event RoomEpochsMarkedSafe(uint256 indexed sourceSequence, uint256 cleared, uint256 skipped);
    event RoomSuspended(uint256 indexed sourceSequence);
    event RoomReopened(uint256 indexed sourceSequence);
    event SlotsClosed(uint256 indexed decisiveSequence, uint256 closed);
    event RoomClosed(uint256 indexed decisiveSequence);
    event RoomClosedByGateStall(uint256 indexed sequence, address indexed caller, uint64 stalledSince);
    event IntegrityBondPosted(address indexed participant, uint256 amount);
    event IntegrityBondClaimed(address indexed participant, uint256 amount);
    event IntegrityBondForfeited(address indexed participant, uint256 amount, uint256 indexed claimId);
    event IntegrityClaimFiled(
        uint256 indexed claimId, address indexed claimant, address indexed participant, bytes32 violationCode
    );
    event IntegrityClaimAdjudicated(uint256 indexed claimId, bool upheld);
    event IntegrityClaimExpired(uint256 indexed claimId);

    error AlreadyInitialized();
    error InvalidConfig();
    error NotAuthorized();
    error RoomIsClosed();
    error RoomNotClosed();
    error SequenceRegression();
    error StaleAttestation();
    error BatchTooLarge();
    error LengthMismatch();
    error UnknownMarket();
    error PermitExpired();
    error PermitTooLongLived();
    error PermitTooOld();
    error PermitNotYetIssued();
    error PermitReplayed();
    error PermitInvalidSigner();
    error PermitMismatch();
    error SlotIndexMismatch();
    error TemplateNotApproved();
    error AnnounceDelayTooShort();
    error TooManyOpenSlots();
    error HeadlineUnbacked();
    error NotHeadlineTemplate();
    error NotReady();
    error InsufficientGas();
    error InvalidState();
    error NothingToClaim();
    error TooEarly();

    constructor() {
        _initialized = true;
    }

    function initialize(RoomConfig calldata config) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (
            config.gateSigner == address(0) || config.publisher == address(0)
                || config.integrityAdjudicator == address(0) || config.participantA == address(0)
                || config.participantB == address(0) || config.participantA == config.participantB
                || config.rewardAddressA == address(0) || config.rewardAddressB == address(0)
                || config.bondRecipient == address(0) || config.gateSigner == config.publisher
                || config.epochDuration == 0 || config.sourceFinalityDelay == 0 || config.maxPendingTime == 0
                || config.challengeWindow == 0 || config.challengeTimeout == 0 || config.maxPermitLifetime == 0
                || config.maxOpenSlots == 0 || config.templates.length == 0 || config.headlineTemplateId == bytes32(0)
                || config.integrityClaimWindow == 0 || config.integrityClaimTimeout == 0 || config.gateStallTimeout == 0
        ) revert InvalidConfig();

        factory = LiveMarketFactory(msg.sender);
        collateral = IERC20(LiveMarketFactory(msg.sender).collateral());
        roomId = config.roomId;
        headlineTemplateId = config.headlineTemplateId;
        gateSigner = config.gateSigner;
        publisher = config.publisher;
        integrityAdjudicator = config.integrityAdjudicator;
        participantA = config.participantA;
        participantB = config.participantB;
        rewardAddressA = config.rewardAddressA;
        rewardAddressB = config.rewardAddressB;
        bondRecipient = config.bondRecipient;
        liquidityRouter = config.liquidityRouter;
        resolvers = config.resolvers;
        epochDuration = config.epochDuration;
        sourceFinalityDelay = config.sourceFinalityDelay;
        maxPendingTime = config.maxPendingTime;
        challengeWindow = config.challengeWindow;
        challengeTimeout = config.challengeTimeout;
        minAnnounceDelay = config.minAnnounceDelay;
        maxPermitLifetime = config.maxPermitLifetime;
        integrityClaimWindow = config.integrityClaimWindow;
        integrityClaimTimeout = config.integrityClaimTimeout;
        gateStallTimeout = config.gateStallTimeout;
        maxOpenSlots = config.maxOpenSlots;
        lastGateActivityAt = uint64(block.timestamp);
        participantAName = config.participantAName;
        participantBName = config.participantBName;

        for (uint256 i = 0; i < config.templates.length; i++) {
            _templateApproved[config.templates[i].templateId] = true;
            _templateReward[config.templates[i].templateId] = config.templates[i].winnerRewardBps;
        }
        for (uint256 i = 0; i < config.restrictedWallets.length; i++) {
            _restricted.push(config.restrictedWallets[i]);
        }
        _restricted.push(config.publisher);
        _restricted.push(config.gateSigner);
        _restricted.push(config.integrityAdjudicator);
    }

    // ------------------------------------------------------------------ views

    function slotCount() external view returns (uint256) {
        return _slots.length;
    }

    function slotAt(uint256 index) external view returns (address) {
        return _slots[index];
    }

    function slots() external view returns (address[] memory) {
        return _slots;
    }

    function openSlotCount() public view returns (uint256) {
        return _openSlots.length;
    }

    function participantsReady() public view returns (bool) {
        return
            integrityBondOf[participantA] == ROOM_INTEGRITY_BOND && integrityBondOf[participantB] == ROOM_INTEGRITY_BOND;
    }

    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    function claimAt(uint256 claimId) external view returns (IntegrityClaim memory) {
        return _claims[claimId];
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function permitDigest(PublicationPermit calldata permit) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                address(this),
                permit.slotIndex,
                permit.requestHash,
                permit.conditionHash,
                permit.undecidedThroughSequence,
                permit.announceDelay,
                permit.issuedAt,
                permit.expiresAt,
                permit.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Canonical hash of the complete slot request and its per-slot
    ///         restricted-wallet list. Everything the publisher supplies is
    ///         covered, so nothing can be varied after the gate signs: template
    ///         id, both parameter hashes, announce delay, winner setting, the
    ///         question text, both media URLs, and the restricted list in order.
    function slotRequestHash(SlotRequest calldata request, address[] calldata restricted)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                request.templateId,
                request.templateParamsHash,
                request.conditionHash,
                request.announceDelay,
                request.winnerRewardBps,
                keccak256(bytes(request.question)),
                keccak256(bytes(request.streamUrl)),
                keccak256(bytes(request.imageUrl)),
                keccak256(abi.encodePacked(restricted))
            )
        );
    }

    // ------------------------------------------------------------ publication

    /// @notice Publishes one Market Slot. Requires the Program Publisher as caller
    ///         AND a fresh, single-use Publication Permit signed by the Source Gate
    ///         Authority attesting the Closing Condition was undecided through
    ///         `permit.undecidedThroughSequence`. Neither key alone can publish.
    function publishSlot(
        SlotRequest calldata request,
        PublicationPermit calldata permit,
        bytes calldata gateSignature,
        address[] calldata restricted
    ) external nonReentrant returns (address market) {
        if (msg.sender != publisher) revert NotAuthorized();
        if (roomClosedSequence != 0) revert RoomIsClosed();
        if (!participantsReady()) revert NotReady();
        uint32 slotIndex = uint32(_slots.length);
        _validatePermit(request, permit, gateSignature, restricted, slotIndex);
        _validateRequest(request, slotIndex);

        // Atomic effects: consume the nonce, advance the watermark, append, deploy.
        usedNonce[permit.nonce] = true;
        lastObservedSequence = permit.undecidedThroughSequence;
        market = _deploySlot(request, restricted);
        emit SlotPublished(
            market,
            slotIndex,
            request.templateId,
            permit.requestHash,
            request.conditionHash,
            permit.nonce,
            permit.undecidedThroughSequence,
            LivePredictionMarket(market).opensAt()
        );
    }

    function _deploySlot(SlotRequest calldata request, address[] calldata restricted)
        internal
        returns (address market)
    {
        uint32 slotIndex = uint32(_slots.length);
        uint64 opensAt = uint64(block.timestamp) + request.announceDelay;
        market = factory.createRoomMarket(
            _buildMarketConfig(request, slotIndex, opensAt), _restrictedFor(restricted), roomId, slotIndex
        );
        _slots.push(market);
        isSlot[market] = true;
        _openSlots.push(market);
        _openIndexPlusOne[market] = _openSlots.length;
    }

    function _validatePermit(
        SlotRequest calldata request,
        PublicationPermit calldata permit,
        bytes calldata gateSignature,
        address[] calldata restricted,
        uint32 slotIndex
    ) internal view {
        if (permit.slotIndex != slotIndex) revert SlotIndexMismatch();
        // The permit binds the complete request, not a subset of it.
        if (
            permit.requestHash != slotRequestHash(request, restricted) || permit.conditionHash != request.conditionHash
                || permit.announceDelay != request.announceDelay
        ) revert PermitMismatch();
        // Freshness is anchored to signed issuance time, in three parts: it
        // cannot be issued in the future, it cannot declare a lifetime longer
        // than the frozen maximum, and it cannot itself be older than that
        // maximum. An expiry-relative bound accepts a stale undecidedness claim
        // whose expiry merely happens to be near.
        if (permit.issuedAt > block.timestamp) revert PermitNotYetIssued();
        if (permit.expiresAt <= block.timestamp) revert PermitExpired();
        if (permit.expiresAt <= permit.issuedAt || permit.expiresAt - permit.issuedAt > maxPermitLifetime) {
            revert PermitTooLongLived();
        }
        if (block.timestamp - permit.issuedAt > maxPermitLifetime) revert PermitTooOld();
        if (usedNonce[permit.nonce]) revert PermitReplayed();
        if (permit.undecidedThroughSequence < lastObservedSequence) revert StaleAttestation();
        if (ECDSA.recover(permitDigest(permit), gateSignature) != gateSigner) revert PermitInvalidSigner();
    }

    function _validateRequest(SlotRequest calldata request, uint32 slotIndex) internal view {
        if (!_templateApproved[request.templateId] || _templateReward[request.templateId] != request.winnerRewardBps) {
            revert TemplateNotApproved();
        }
        if (request.announceDelay < minAnnounceDelay) revert AnnounceDelayTooShort();
        if (_openSlots.length >= maxOpenSlots) revert TooManyOpenSlots();
        if (slotIndex == 0) {
            if (request.templateId != headlineTemplateId) revert NotHeadlineTemplate();
        } else if (!LivePredictionMarket(_slots[0]).hasLiquidity()) {
            revert HeadlineUnbacked();
        }
    }

    function _buildMarketConfig(SlotRequest calldata request, uint32 slotIndex, uint64 opensAt)
        internal
        view
        returns (LivePredictionMarket.MarketConfig memory config)
    {
        config.collateral = address(collateral);
        config.admin = address(this);
        config.gateOracle = address(this);
        config.participantA = participantA;
        config.participantB = participantB;
        config.rewardAddressA = rewardAddressA;
        config.rewardAddressB = rewardAddressB;
        config.bondRecipient = bondRecipient;
        config.resolvers = resolvers;
        config.epochDuration = epochDuration;
        config.sourceFinalityDelay = sourceFinalityDelay;
        config.maxPendingTime = maxPendingTime;
        config.challengeWindow = challengeWindow;
        config.challengeTimeout = challengeTimeout;
        config.roomId = roomId;
        config.slotIndex = slotIndex;
        config.templateId = request.templateId;
        config.conditionHash = request.conditionHash;
        config.winnerRewardBps = request.winnerRewardBps;
        config.opensAt = opensAt;
        config.readinessSource = address(this);
        config.liquidityRouter = liquidityRouter;
        config.participantAName = participantAName;
        config.participantBName = participantBName;
        config.question = request.question;
        config.streamUrl = request.streamUrl;
        config.imageUrl = request.imageUrl;
    }

    function _restrictedFor(address[] calldata extra) internal view returns (address[] memory combined) {
        combined = new address[](_restricted.length + extra.length);
        for (uint256 i = 0; i < _restricted.length; i++) {
            combined[i] = _restricted[i];
        }
        for (uint256 i = 0; i < extra.length; i++) {
            combined[_restricted.length + i] = extra[i];
        }
    }

    // ---------------------------------------------------------------- gating

    modifier onlyGate() {
        if (msg.sender != gateSigner) revert NotAuthorized();
        _;
    }

    function _advanceSequence(uint256 sourceSequence) internal {
        if (roomClosedSequence != 0) revert RoomIsClosed();
        if (sourceSequence < lastObservedSequence) revert SequenceRegression();
        lastObservedSequence = sourceSequence;
        // Any gate action proves the gate is alive and resets the stall clock,
        // so a merely slow gate is never closed out from under itself.
        lastGateActivityAt = uint64(block.timestamp);
    }

    /// @notice Marks one completed epoch safe on every listed market in a single
    ///         transaction. Child failures are isolated: a reverting market is
    ///         skipped with `SlotCallSkipped` and retryable at the same sequence.
    function markRoomEpochsSafe(uint256 sourceSequence, address[] calldata markets, uint64[] calldata epochs)
        external
        onlyGate
    {
        if (markets.length != epochs.length) revert LengthMismatch();
        if (markets.length > MAX_BATCH) revert BatchTooLarge();
        _advanceSequence(sourceSequence);
        uint256 cleared;
        uint256 skipped;
        for (uint256 i = 0; i < markets.length; i++) {
            if (!isSlot[markets[i]]) revert UnknownMarket();
            try LivePredictionMarket(markets[i]).markEpochSafe{gas: CHILD_CALL_GAS}(epochs[i], sourceSequence) {
                cleared++;
            } catch (bytes memory reason) {
                skipped++;
                emit SlotCallSkipped(markets[i], epochs[i], _selectorOf(reason), reason);
            }
        }
        emit RoomEpochsMarkedSafe(sourceSequence, cleared, skipped);
    }

    function suspendRoom(uint256 sourceSequence) external onlyGate {
        _advanceSequence(sourceSequence);
        for (uint256 i = 0; i < _openSlots.length; i++) {
            try LivePredictionMarket(_openSlots[i]).suspendGate{gas: CHILD_CALL_GAS}(sourceSequence) {}
            catch (bytes memory reason) {
                emit SlotCallSkipped(_openSlots[i], 0, _selectorOf(reason), reason);
            }
        }
        emit RoomSuspended(sourceSequence);
    }

    function reopenRoom(uint256 sourceSequence) external onlyGate {
        _advanceSequence(sourceSequence);
        for (uint256 i = 0; i < _openSlots.length; i++) {
            try LivePredictionMarket(_openSlots[i]).reopenGate{gas: CHILD_CALL_GAS}(sourceSequence) {}
            catch (bytes memory reason) {
                emit SlotCallSkipped(_openSlots[i], 0, _selectorOf(reason), reason);
            }
        }
        emit RoomReopened(sourceSequence);
    }

    /// @notice Closes the listed slots for their Decisive Event. A micro slot's
    ///         Decisive Event closes only that slot; the room continues.
    function closeSlots(uint256 decisiveSequence, address[] calldata markets) external onlyGate {
        if (markets.length > MAX_BATCH) revert BatchTooLarge();
        _advanceSequence(decisiveSequence);
        uint256 closed = _closeEach(decisiveSequence, markets);
        emit SlotsClosed(decisiveSequence, closed);
    }

    /// @notice Records the Live Session's terminal sequence. Irreversible. After
    ///         this, `closeRemainingSlots` is permissionless so a stalled or
    ///         censoring operator cannot trap pending actions.
    /// @notice Closes the room on the session's decisive event.
    /// @dev The closing sequence is raised to one past the room watermark when
    ///      the decisive event lands on or behind it. A market rejects
    ///      `closeForDecisiveEvent` at a sequence it has already cleared at, and
    ///      the room swallows that as a skip — so closing exactly ON the
    ///      watermark wrote `roomClosedSequence` irreversibly and then left
    ///      every slot Open with no way to shut it: `closeSlots` and
    ///      `closeRoomOnGateStall` both revert on a closed room, and
    ///      `closeRemainingSlots` can only replay the sequence already failing.
    ///      Positions, LP inventory and the room's Integrity Bonds all stranded
    ///      behind it.
    ///
    ///      This is the invariant `closeRoomOnGateStall` already relies on: one
    ///      past the room watermark, which every market's own watermark is
    ///      bounded by, so the close is accepted by all of them.
    function closeRoom(uint256 decisiveSequence) external onlyGate {
        uint256 sequence = decisiveSequence > lastObservedSequence ? decisiveSequence : lastObservedSequence + 1;
        _advanceSequence(sequence);
        roomClosedSequence = sequence;
        roomClosedAt = uint64(block.timestamp);
        emit RoomClosed(sequence);
    }

    /// @notice Permissionless recovery from a dead or lost gate key. After the
    ///         frozen stall timeout with no gate action, anyone may close the
    ///         room. Every market can then be closed, resolution runs its normal
    ///         fail-closed path to Invalid, and positions, LP inventory, and
    ///         Integrity Bonds all become claimable.
    /// @dev This is the difference between failing closed and failing stuck.
    ///      It cannot shortcut a live gate: any gate action resets the clock.
    function closeRoomOnGateStall() external {
        if (roomClosedSequence != 0) revert RoomIsClosed();
        if (block.timestamp < uint256(lastGateActivityAt) + gateStallTimeout) revert TooEarly();
        // One past the room watermark, which every market's own watermark is
        // bounded by, so `closeForDecisiveEvent` is accepted by all of them.
        uint256 sequence = lastObservedSequence + 1;
        roomClosedSequence = sequence;
        roomClosedAt = uint64(block.timestamp);
        closedByStall = true;
        emit RoomClosedByGateStall(sequence, msg.sender, lastGateActivityAt);
        emit RoomClosed(sequence);
    }

    function closeRemainingSlots(address[] calldata markets) external {
        if (roomClosedSequence == 0) revert RoomNotClosed();
        if (markets.length > MAX_BATCH) revert BatchTooLarge();
        _closeEach(roomClosedSequence, markets);
    }

    function _closeEach(uint256 sequence, address[] calldata markets) internal returns (uint256 closed) {
        for (uint256 i = 0; i < markets.length; i++) {
            if (!isSlot[markets[i]]) revert UnknownMarket();
            try LivePredictionMarket(markets[i]).closeForDecisiveEvent{gas: CHILD_CALL_GAS}(sequence) {
                _removeOpenSlot(markets[i]);
                closed++;
            } catch (bytes memory reason) {
                emit SlotCallSkipped(markets[i], 0, _selectorOf(reason), reason);
            }
        }
    }

    /// @notice Permissionless: anyone may push cleared or refundable epochs through.
    /// @dev Unlike gating, this call executes real market work whose cost scales
    ///      with the actions in the epoch, so a fixed stipend is wrong: it
    ///      silently starves execution, and because child failures are isolated
    ///      the starvation is invisible. Each child instead receives a fair
    ///      share of the gas actually available, above a floor.
    function processRoom(address[] calldata markets, uint64[] calldata epochs, uint256 maxActions) external {
        if (markets.length != epochs.length) revert LengthMismatch();
        if (markets.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < markets.length; i++) {
            if (!isSlot[markets[i]]) revert UnknownMarket();
            uint256 available = gasleft();
            uint256 share = available > BATCH_GAS_RESERVE ? (available - BATCH_GAS_RESERVE) / (markets.length - i) : 0;
            // Reverting — rather than skipping — is essential. A cheap skip
            // path is self-fulfilling under gas estimation: the estimator finds
            // that a low limit "succeeds" (because everything is skipped) and
            // returns it, so the batch never does any work and never says so.
            // Refusing forces the estimator to find a limit that actually runs.
            if (share < MIN_PROCESS_GAS) revert InsufficientGas();
            try LivePredictionMarket(markets[i]).processEpoch{gas: share}(epochs[i], maxActions) {}
            catch (bytes memory reason) {
                emit SlotCallSkipped(markets[i], epochs[i], _selectorOf(reason), reason);
            }
        }
    }

    function _removeOpenSlot(address market) internal {
        uint256 indexPlusOne = _openIndexPlusOne[market];
        if (indexPlusOne == 0) return;
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _openSlots.length - 1;
        if (index != lastIndex) {
            address moved = _openSlots[lastIndex];
            _openSlots[index] = moved;
            _openIndexPlusOne[moved] = index + 1;
        }
        _openSlots.pop();
        _openIndexPlusOne[market] = 0;
    }

    function _selectorOf(bytes memory reason) internal pure returns (bytes4 selector) {
        if (reason.length >= 4) {
            assembly {
                selector := mload(add(reason, 32))
            }
        }
    }

    // ------------------------------------------------------- integrity bonds

    /// @notice One bond per Participant per Live Session, held by the room.
    function postIntegrityBond() external nonReentrant {
        if (msg.sender != participantA && msg.sender != participantB) revert NotAuthorized();
        if (integrityBondOf[msg.sender] != 0) revert InvalidState();
        integrityBondOf[msg.sender] = ROOM_INTEGRITY_BOND;
        collateral.safeTransferFrom(msg.sender, address(this), ROOM_INTEGRITY_BOND);
        emit IntegrityBondPosted(msg.sender, ROOM_INTEGRITY_BOND);
    }

    /// @notice Releases a Participant's bond only when all four hold: the room's
    ///         terminal condition occurred, no further slot can ever be published,
    ///         every published slot is Final or Invalid, and the Integrity Claim
    ///         Window elapsed with no unresolved claim against the Participant.
    function claimIntegrityBond() external nonReentrant {
        if (msg.sender != participantA && msg.sender != participantB) revert NotAuthorized();
        if (integrityBondClaimed[msg.sender]) revert NothingToClaim();
        // A closed room can never publish again — `publishSlot` reverts on
        // `roomClosedSequence != 0` — so the "no further slot" release condition
        // is established by the check above rather than by a separate assertion.
        if (roomClosedSequence == 0) revert RoomNotClosed();
        for (uint256 i = 0; i < _slots.length; i++) {
            if (LivePredictionMarket(_slots[i]).finalOutcome() == LivePredictionMarket.Outcome.Unset) {
                revert TooEarly();
            }
        }
        if (block.timestamp < uint256(roomClosedAt) + integrityClaimWindow) revert TooEarly();
        if (openClaimsAgainst[msg.sender] != 0) revert TooEarly();

        uint256 amount = integrityBondOf[msg.sender];
        if (amount == 0) revert NothingToClaim();
        integrityBondClaimed[msg.sender] = true;
        integrityBondOf[msg.sender] = 0;
        collateral.safeTransfer(msg.sender, amount);
        emit IntegrityBondClaimed(msg.sender, amount);
    }

    /// @notice Files a bonded Integrity Claim against one Participant during the
    ///         claim window. A claim can change only that bond's disposition; it
    ///         cannot select the Winner or change market settlement.
    function fileIntegrityClaim(address participant, bytes32 violationCode, bytes32 evidenceHash)
        external
        nonReentrant
        returns (uint256 claimId)
    {
        if (participant != participantA && participant != participantB) revert InvalidState();
        if (violationCode == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidState();
        if (roomClosedSequence == 0) revert RoomNotClosed();
        if (block.timestamp >= uint256(roomClosedAt) + integrityClaimWindow) revert TooEarly();
        if (integrityBondOf[participant] == 0) revert NothingToClaim();

        claimId = _claims.length;
        _claims.push(
            IntegrityClaim({
                claimant: msg.sender,
                participant: participant,
                violationCode: violationCode,
                evidenceHash: evidenceHash,
                filedAt: uint64(block.timestamp),
                status: ClaimStatus.Open
            })
        );
        openClaimsAgainst[participant]++;
        collateral.safeTransferFrom(msg.sender, address(this), INTEGRITY_CLAIM_BOND);
        emit IntegrityClaimFiled(claimId, msg.sender, participant, violationCode);
    }

    function adjudicateIntegrityClaim(uint256 claimId, bool uphold) external nonReentrant {
        if (msg.sender != integrityAdjudicator) revert NotAuthorized();
        IntegrityClaim storage claim = _claims[claimId];
        if (claim.status != ClaimStatus.Open) revert InvalidState();
        if (block.timestamp >= claim.filedAt + integrityClaimTimeout) revert TooEarly();
        openClaimsAgainst[claim.participant]--;
        if (uphold) {
            claim.status = ClaimStatus.Upheld;
            uint256 forfeited = integrityBondOf[claim.participant];
            integrityBondOf[claim.participant] = 0;
            if (forfeited != 0) {
                collateral.safeTransfer(bondRecipient, forfeited);
                emit IntegrityBondForfeited(claim.participant, forfeited, claimId);
            }
            collateral.safeTransfer(claim.claimant, INTEGRITY_CLAIM_BOND);
        } else {
            claim.status = ClaimStatus.Rejected;
            collateral.safeTransfer(bondRecipient, INTEGRITY_CLAIM_BOND);
        }
        emit IntegrityClaimAdjudicated(claimId, uphold);
    }

    /// @notice An unadjudicated claim expires after the frozen timeout: the
    ///         Participant's bond stays returnable (returnable unless upheld) and
    ///         the claimant's bond comes back. Permissionless.
    function expireIntegrityClaim(uint256 claimId) external nonReentrant {
        IntegrityClaim storage claim = _claims[claimId];
        if (claim.status != ClaimStatus.Open) revert InvalidState();
        if (block.timestamp < claim.filedAt + integrityClaimTimeout) revert TooEarly();
        claim.status = ClaimStatus.Expired;
        openClaimsAgainst[claim.participant]--;
        collateral.safeTransfer(claim.claimant, INTEGRITY_CLAIM_BOND);
        emit IntegrityClaimExpired(claimId);
    }
}
