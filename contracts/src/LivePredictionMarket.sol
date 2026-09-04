// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarketMath} from "./MarketMath.sol";
import {IRoomReadiness} from "./interfaces/IRoomReadiness.sol";

/// @title LivePredictionMarket
/// @notice A two-outcome, community-funded FPMM with source-cleared Forecasting Epochs.
/// @dev Testnet MVP. This contract is intentionally non-upgradeable so frozen market rules cannot change.
contract LivePredictionMarket is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GATE_ROLE = keccak256("GATE_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant LIQUIDITY_ROUTER_ROLE = keccak256("LIQUIDITY_ROUTER_ROLE");

    uint256 public constant USDC_UNIT = 1e6;
    uint256 public constant MIN_PURCHASE = 1e6;
    uint256 public constant MIN_LIQUIDITY = 1e6;
    uint256 public constant MAX_ACTION_AMOUNT = 1_000_000_000 * 1e6;
    uint256 public constant INTEGRITY_BOND = 100 * 1e6;
    uint256 public constant CHALLENGE_BOND = 10 * 1e6;
    uint256 private constant FEE_SCALE = 1e18;

    enum GateState {
        Open,
        Suspended,
        Closed
    }

    enum Outcome {
        Unset,
        ParticipantA,
        ParticipantB,
        Tie,
        Invalid
    }

    enum ActionKind {
        Buy,
        Sell,
        AddLiquidity,
        TransferPosition
    }

    enum ActionStatus {
        Pending,
        Executed,
        Refunded
    }

    struct MarketConfig {
        address collateral;
        address admin;
        address gateOracle;
        address participantA;
        address participantB;
        address rewardAddressA;
        address rewardAddressB;
        address bondRecipient;
        address[3] resolvers;
        uint64 epochDuration;
        uint64 sourceFinalityDelay;
        uint64 maxPendingTime;
        uint64 challengeWindow;
        uint64 challengeTimeout;
        bytes32 roomId;
        uint32 slotIndex;
        bytes32 templateId;
        bytes32 conditionHash;
        uint16 winnerRewardBps;
        uint64 opensAt;
        address readinessSource;
        address liquidityRouter;
        string participantAName;
        string participantBName;
        string question;
        string streamUrl;
        string imageUrl;
    }

    struct PendingAction {
        ActionKind kind;
        ActionStatus status;
        address user;
        address recipient;
        bool participantAOutcome;
        uint64 epoch;
        uint64 deadline;
        uint256 amount;
        uint256 minimumReturn;
    }

    IERC20 public collateral;
    address public marketAdministrator;
    address public participantA;
    address public participantB;
    address public rewardAddressA;
    address public rewardAddressB;
    address public bondRecipient;
    uint64 public epochDuration;
    uint64 public sourceFinalityDelay;
    uint64 public maxPendingTime;
    uint64 public challengeWindow;
    uint64 public challengeTimeout;
    bytes32 internal roomId;
    uint32 internal slotIndex;
    bytes32 internal templateId;
    bytes32 internal conditionHash;
    uint16 public winnerRewardBps;
    uint64 public opensAt;
    address public readinessSource;
    bool private _initialized;

    string public participantAName;
    string public participantBName;
    string public question;
    string public streamUrl;
    string public imageUrl;

    GateState public gateState;
    Outcome public provisionalOutcome;
    Outcome public finalOutcome;
    bytes32 public provisionalEvidenceHash;
    uint64 public provisionalAt;
    uint64 public closedAt;
    uint64 public closedEpoch;
    uint64 public resolutionDueAt;
    uint256 public decisiveSequence;
    uint256 public lastSafeSequence;

    uint256 public reserveA;
    uint256 public reserveB;
    uint256 public totalLpShares;
    uint256 public feePerShare;
    uint256 public unclaimedLpFees;
    uint256 public winnerRewardPool;
    uint256 public collateralBacking;
    uint256 public pendingCollateral;
    uint256 public totalIntegrityBondLiability;

    mapping(address => bool) public restrictedWallet;
    mapping(address => uint256) public integrityBondOf;
    mapping(address => uint256) public positionAOf;
    mapping(address => uint256) public positionBOf;
    mapping(address => uint256) public lpSharesOf;
    mapping(address => uint256) public lpFeeDebt;
    mapping(address => uint256) public lpFeeCredit;
    mapping(address => uint256) public winnerFeePaid;
    mapping(address => bool) public lpInventorySettled;
    mapping(address => bool) public integrityBondClaimed;
    mapping(address => bool) public winnerRewardClaimed;

    PendingAction[] public actions;
    mapping(uint64 => uint256[]) private _epochActionIds;
    mapping(uint64 => uint256) public epochCursor;
    mapping(uint64 => bool) public epochSafe;
    mapping(uint64 => uint256) public epochSafeSequence;

    mapping(bytes32 => uint8) public resultAttestationCount;
    mapping(bytes32 => mapping(address => bool)) public resultAttestedBy;
    bool public challenged;
    address public challenger;
    bytes32 public challengeEvidenceHash;
    uint256 public challengeBond;
    uint64 public challengedAt;
    mapping(bool => uint8) public challengeVerdictCount;
    mapping(bool => mapping(address => bool)) public challengeVerdictBy;

    event IntegrityBondPosted(address indexed participant, uint256 amount);
    event IntegrityBondClaimed(address indexed participant, uint256 amount);
    event ActionSubmitted(
        uint256 indexed actionId, uint64 indexed epoch, ActionKind kind, address indexed user, uint256 amount
    );
    event ActionExecuted(uint256 indexed actionId, uint64 indexed epoch, uint256 returnAmount);
    event ActionRefunded(uint256 indexed actionId, uint64 indexed epoch, uint256 amount);
    event EpochMarkedSafe(uint64 indexed epoch, uint256 indexed sourceSequence);
    event GateSuspended(uint256 indexed sourceSequence);
    event GateReopened(uint256 indexed sourceSequence);
    event ForecastingClosed(uint64 indexed epoch, uint256 indexed decisiveSequence);
    event Trade(
        address indexed user, bool indexed participantAOutcome, bool indexed isBuy, uint256 amountIn, uint256 amountOut
    );
    event PositionTransferred(
        address indexed from, address indexed to, bool indexed participantAOutcome, uint256 amount
    );
    event LiquidityAdded(
        address indexed provider,
        uint256 collateralAmount,
        uint256 sharesMinted,
        uint256 adjustmentA,
        uint256 adjustmentB
    );
    event LpFeesClaimed(address indexed provider, uint256 amount);
    event PositionsRedeemed(address indexed user, uint256 amountA, uint256 amountB, uint256 payout);
    event LpInventorySettled(address indexed provider, uint256 shares, uint256 payout);
    event ResultAttested(address indexed resolver, Outcome outcome, bytes32 indexed evidenceHash, uint8 count);
    event ProvisionalResultRegistered(Outcome outcome, bytes32 indexed evidenceHash, uint64 challengeEndsAt);
    event ResultChallenged(address indexed challenger, bytes32 indexed evidenceHash, uint256 bond);
    event ChallengeVerdictAttested(address indexed resolver, bool acceptChallenge, uint8 count);
    event ResultFinalized(Outcome outcome);
    event WinnerRewardClaimed(address indexed recipient, uint256 amount);
    event InvalidWinnerFeeRefunded(address indexed forecaster, uint256 amount);

    error NotReady();
    error NotEligible();
    error InvalidState();
    error InvalidAmount();
    error InvalidDeadline();
    error NoLiquidity();
    error NothingToClaim();
    error TooEarly();
    error WrongEpoch();
    error DuplicateAttestation();
    error AlreadyInitialized();
    error RoomManagesBonds();

    constructor() {
        _initialized = true;
    }

    function initialize(MarketConfig calldata config, address[] calldata additionalRestrictedWallets) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (
            config.collateral == address(0) || config.admin == address(0) || config.gateOracle == address(0)
                || config.participantA == address(0) || config.participantB == address(0)
                || config.participantA == config.participantB || config.rewardAddressA == address(0)
                || config.rewardAddressB == address(0) || config.bondRecipient == address(0)
                || config.epochDuration == 0 || config.sourceFinalityDelay == 0 || config.maxPendingTime == 0
                || config.challengeWindow == 0 || config.challengeTimeout == 0
                || config.winnerRewardBps > MarketMath.MAX_WINNER_REWARD_BPS
                || config.resolvers[0] == config.resolvers[1] || config.resolvers[0] == config.resolvers[2]
                || config.resolvers[1] == config.resolvers[2]
        ) revert InvalidState();

        collateral = IERC20(config.collateral);
        marketAdministrator = config.admin;
        participantA = config.participantA;
        participantB = config.participantB;
        rewardAddressA = config.rewardAddressA;
        rewardAddressB = config.rewardAddressB;
        bondRecipient = config.bondRecipient;
        epochDuration = config.epochDuration;
        sourceFinalityDelay = config.sourceFinalityDelay;
        maxPendingTime = config.maxPendingTime;
        challengeWindow = config.challengeWindow;
        challengeTimeout = config.challengeTimeout;
        roomId = config.roomId;
        slotIndex = config.slotIndex;
        templateId = config.templateId;
        conditionHash = config.conditionHash;
        winnerRewardBps = config.winnerRewardBps;
        opensAt = config.opensAt;
        readinessSource = config.readinessSource;
        participantAName = config.participantAName;
        participantBName = config.participantBName;
        question = config.question;
        streamUrl = config.streamUrl;
        imageUrl = config.imageUrl;
        gateState = GateState.Open;

        _grantRole(GATE_ROLE, config.gateOracle);
        for (uint256 i = 0; i < config.resolvers.length; i++) {
            if (config.resolvers[i] == address(0)) revert InvalidState();
            _grantRole(RESOLVER_ROLE, config.resolvers[i]);
            restrictedWallet[config.resolvers[i]] = true;
        }

        restrictedWallet[config.participantA] = true;
        restrictedWallet[config.participantB] = true;
        restrictedWallet[config.rewardAddressA] = true;
        restrictedWallet[config.rewardAddressB] = true;
        restrictedWallet[config.gateOracle] = true;
        if (config.liquidityRouter != address(0)) {
            _grantRole(LIQUIDITY_ROUTER_ROLE, config.liquidityRouter);
            restrictedWallet[config.liquidityRouter] = true;
        }
        for (uint256 i = 0; i < additionalRestrictedWallets.length; i++) {
            restrictedWallet[additionalRestrictedWallets[i]] = true;
        }
    }

    modifier onlyReady() {
        if (!isReady()) revert NotReady();
        _;
    }

    modifier onlyEligible() {
        if (restrictedWallet[msg.sender]) revert NotEligible();
        _;
    }

    modifier onlyFinal() {
        if (finalOutcome == Outcome.Unset) revert InvalidState();
        _;
    }

    function isReady() public view returns (bool) {
        if (readinessSource != address(0)) return IRoomReadiness(readinessSource).participantsReady();
        return integrityBondOf[participantA] == INTEGRITY_BOND && integrityBondOf[participantB] == INTEGRITY_BOND;
    }

    function hasLiquidity() public view returns (bool) {
        return totalLpShares != 0;
    }

    /// @notice The frozen room binding: which room, slot, template, and condition this market settles.
    function slotBinding() external view returns (bytes32, uint32, bytes32, bytes32, uint16) {
        return (roomId, slotIndex, templateId, conditionHash, winnerRewardBps);
    }

    function currentEpoch() public view returns (uint64) {
        return uint64(block.timestamp / epochDuration);
    }

    function epochEndsAt(uint64 epoch) public view returns (uint256) {
        return (uint256(epoch) + 1) * epochDuration;
    }

    function epochActionIds(uint64 epoch) external view returns (uint256[] memory) {
        return _epochActionIds[epoch];
    }

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function spotPriceA() external view returns (uint256) {
        return MarketMath.spotPriceA(reserveA, reserveB);
    }

    function quoteBuy(bool participantAOutcome, uint256 budget) external view returns (MarketMath.BuyQuote memory) {
        if (!hasLiquidity()) revert NoLiquidity();
        return participantAOutcome
            ? MarketMath.quoteBuy(reserveA, reserveB, budget, winnerRewardBps)
            : MarketMath.quoteBuy(reserveB, reserveA, budget, winnerRewardBps);
    }

    function quoteSell(bool participantAOutcome, uint256 positionsIn)
        external
        view
        returns (MarketMath.SellQuote memory)
    {
        if (!hasLiquidity()) revert NoLiquidity();
        return participantAOutcome
            ? MarketMath.quoteSell(reserveA, reserveB, positionsIn)
            : MarketMath.quoteSell(reserveB, reserveA, positionsIn);
    }

    function quoteLiquidityShares(uint256 amount) external view returns (uint256) {
        if (!hasLiquidity()) return amount;
        return Math.mulDiv(amount, totalLpShares, Math.max(reserveA, reserveB));
    }

    function accountedLiabilities() external view returns (uint256) {
        uint256 heldChallengeBond = challenged && finalOutcome == Outcome.Unset ? challengeBond : 0;
        return collateralBacking + winnerRewardPool + unclaimedLpFees + pendingCollateral + totalIntegrityBondLiability
            + heldChallengeBond;
    }

    function postIntegrityBond() external nonReentrant {
        if (readinessSource != address(0)) revert RoomManagesBonds();
        if (msg.sender != participantA && msg.sender != participantB) revert NotEligible();
        if (integrityBondOf[msg.sender] != 0) revert InvalidState();

        integrityBondOf[msg.sender] = INTEGRITY_BOND;
        totalIntegrityBondLiability += INTEGRITY_BOND;
        collateral.safeTransferFrom(msg.sender, address(this), INTEGRITY_BOND);
        emit IntegrityBondPosted(msg.sender, INTEGRITY_BOND);
    }

    function submitBuy(bool participantAOutcome, uint256 budget, uint256 minimumPositions, uint64 deadline)
        external
        nonReentrant
        onlyReady
        onlyEligible
        returns (uint256 actionId)
    {
        if (!hasLiquidity()) revert NoLiquidity();
        if (budget < MIN_PURCHASE || budget > MAX_ACTION_AMOUNT) revert InvalidAmount();
        actionId = _submitCollateralAction(ActionKind.Buy, participantAOutcome, budget, minimumPositions, deadline);
    }

    function submitAddLiquidity(uint256 amount, uint256 minimumShares, uint64 deadline)
        external
        nonReentrant
        onlyReady
        onlyEligible
        returns (uint256 actionId)
    {
        actionId = _submitLiquidityAction(msg.sender, amount, minimumShares, deadline);
    }

    /// @notice Adds liquidity on behalf of `provider`, pulling collateral from the caller.
    /// @dev Room liquidity commitments only: the router role is frozen at initialization and the
    ///      router itself is a restricted wallet, so it can never accumulate shares or positions.
    ///      Shares, the fee checkpoint, and any refund all land on `provider`.
    function submitAddLiquidityFor(address provider, uint256 amount, uint256 minimumShares, uint64 deadline)
        external
        nonReentrant
        onlyRole(LIQUIDITY_ROUTER_ROLE)
        onlyReady
        returns (uint256 actionId)
    {
        if (provider == address(0) || restrictedWallet[provider]) revert NotEligible();
        actionId = _submitLiquidityAction(provider, amount, minimumShares, deadline);
    }

    function _submitLiquidityAction(address provider, uint256 amount, uint256 minimumShares, uint64 deadline)
        internal
        returns (uint256 actionId)
    {
        if (amount < MIN_LIQUIDITY || amount > MAX_ACTION_AMOUNT) revert InvalidAmount();
        _requireActionWindow(deadline);
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        pendingCollateral += amount;
        actionId = _recordAction(ActionKind.AddLiquidity, provider, address(0), false, amount, minimumShares, deadline);
    }

    function _submitCollateralAction(
        ActionKind kind,
        bool participantAOutcome,
        uint256 amount,
        uint256 minimumReturn,
        uint64 deadline
    ) internal returns (uint256 actionId) {
        _requireActionWindow(deadline);
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        pendingCollateral += amount;
        actionId = _recordAction(kind, msg.sender, address(0), participantAOutcome, amount, minimumReturn, deadline);
    }

    function submitSell(bool participantAOutcome, uint256 positionsIn, uint256 minimumCollateral, uint64 deadline)
        external
        nonReentrant
        onlyReady
        onlyEligible
        returns (uint256 actionId)
    {
        if (positionsIn == 0 || positionsIn > MAX_ACTION_AMOUNT) revert InvalidAmount();
        _requireActionWindow(deadline);
        _debitPosition(msg.sender, participantAOutcome, positionsIn);
        actionId = _recordAction(
            ActionKind.Sell, msg.sender, address(0), participantAOutcome, positionsIn, minimumCollateral, deadline
        );
    }

    function submitPositionTransfer(bool participantAOutcome, address recipient, uint256 amount, uint64 deadline)
        external
        nonReentrant
        onlyReady
        onlyEligible
        returns (uint256 actionId)
    {
        if (recipient == address(0) || restrictedWallet[recipient]) revert NotEligible();
        if (amount == 0 || amount > MAX_ACTION_AMOUNT) revert InvalidAmount();
        _requireActionWindow(deadline);
        _debitPosition(msg.sender, participantAOutcome, amount);
        actionId =
            _recordAction(ActionKind.TransferPosition, msg.sender, recipient, participantAOutcome, amount, 0, deadline);
    }

    function _recordAction(
        ActionKind kind,
        address user,
        address recipient,
        bool participantAOutcome,
        uint256 amount,
        uint256 minimumReturn,
        uint64 deadline
    ) internal returns (uint256 actionId) {
        uint64 epoch = currentEpoch();
        actionId = actions.length;
        actions.push(
            PendingAction({
                kind: kind,
                status: ActionStatus.Pending,
                user: user,
                recipient: recipient,
                participantAOutcome: participantAOutcome,
                epoch: epoch,
                deadline: deadline,
                amount: amount,
                minimumReturn: minimumReturn
            })
        );
        _epochActionIds[epoch].push(actionId);
        emit ActionSubmitted(actionId, epoch, kind, user, amount);
    }

    function _requireActionWindow(uint64 deadline) internal view {
        if (gateState != GateState.Open) revert InvalidState();
        if (block.timestamp < opensAt) revert TooEarly();
        if (deadline <= block.timestamp) revert InvalidDeadline();
    }

    function markEpochSafe(uint64 epoch, uint256 sourceSequence) external onlyRole(GATE_ROLE) {
        if (epoch >= currentEpoch()) revert TooEarly();
        if (block.timestamp < epochEndsAt(epoch) + sourceFinalityDelay) revert TooEarly();
        if (epochSafe[epoch] || sourceSequence <= lastSafeSequence) revert InvalidState();
        if (gateState == GateState.Closed && (epoch >= closedEpoch || sourceSequence >= decisiveSequence)) {
            revert WrongEpoch();
        }
        epochSafe[epoch] = true;
        epochSafeSequence[epoch] = sourceSequence;
        lastSafeSequence = sourceSequence;
        emit EpochMarkedSafe(epoch, sourceSequence);
    }

    function processEpoch(uint64 epoch, uint256 maximumActions) external nonReentrant returns (uint256 processed) {
        uint256 cursor = epochCursor[epoch];
        uint256[] storage ids = _epochActionIds[epoch];
        if (cursor >= ids.length || maximumActions == 0) return 0;

        bool canExecute = epochSafe[epoch] && (gateState != GateState.Closed || epoch < closedEpoch);
        bool canRefund = (gateState == GateState.Closed && epoch >= closedEpoch)
            || block.timestamp > epochEndsAt(epoch) + maxPendingTime;
        if (!canExecute && !canRefund) revert TooEarly();

        uint256 remaining = ids.length - cursor;
        uint256 end = maximumActions >= remaining ? ids.length : cursor + maximumActions;
        for (uint256 i = cursor; i < end; i++) {
            PendingAction storage action = actions[ids[i]];
            if (action.status != ActionStatus.Pending) continue;

            if (canExecute && block.timestamp <= action.deadline) {
                (bool executed, uint256 returnAmount) = _tryExecute(action);
                if (executed) {
                    action.status = ActionStatus.Executed;
                    emit ActionExecuted(ids[i], epoch, returnAmount);
                } else {
                    _refund(action);
                    emit ActionRefunded(ids[i], epoch, action.amount);
                }
            } else {
                _refund(action);
                emit ActionRefunded(ids[i], epoch, action.amount);
            }
            processed++;
        }
        epochCursor[epoch] = end;
    }

    function _tryExecute(PendingAction storage action) internal returns (bool, uint256) {
        if (action.kind == ActionKind.Buy) return _executeBuy(action);
        if (action.kind == ActionKind.Sell) return _executeSell(action);
        if (action.kind == ActionKind.AddLiquidity) return _executeAddLiquidity(action);

        _creditPosition(action.recipient, action.participantAOutcome, action.amount);
        emit PositionTransferred(action.user, action.recipient, action.participantAOutcome, action.amount);
        return (true, action.amount);
    }

    function _executeBuy(PendingAction storage action) internal returns (bool, uint256) {
        MarketMath.BuyQuote memory quote = action.participantAOutcome
            ? MarketMath.quoteBuy(reserveA, reserveB, action.amount, winnerRewardBps)
            : MarketMath.quoteBuy(reserveB, reserveA, action.amount, winnerRewardBps);
        if (quote.positionsOut < action.minimumReturn || quote.positionsOut == 0) return (false, 0);

        pendingCollateral -= action.amount;
        collateralBacking += quote.tradeInput;
        winnerRewardPool += quote.winnerRewardFee;
        winnerFeePaid[action.user] += quote.winnerRewardFee;
        _distributeLpFee(quote.liquidityFee);

        if (action.participantAOutcome) {
            reserveA = quote.newSelectedReserve;
            reserveB = quote.newOtherReserve;
        } else {
            reserveB = quote.newSelectedReserve;
            reserveA = quote.newOtherReserve;
        }
        _creditPosition(action.user, action.participantAOutcome, quote.positionsOut);
        emit Trade(action.user, action.participantAOutcome, true, action.amount, quote.positionsOut);
        return (true, quote.positionsOut);
    }

    function _executeSell(PendingAction storage action) internal returns (bool, uint256) {
        MarketMath.SellQuote memory quote = action.participantAOutcome
            ? MarketMath.quoteSell(reserveA, reserveB, action.amount)
            : MarketMath.quoteSell(reserveB, reserveA, action.amount);
        if (quote.collateralOut < action.minimumReturn || quote.grossCollateral == 0) return (false, 0);

        collateralBacking -= quote.grossCollateral;
        _distributeLpFee(quote.liquidityFee);
        if (action.participantAOutcome) {
            reserveA = quote.newSelectedReserve;
            reserveB = quote.newOtherReserve;
        } else {
            reserveB = quote.newSelectedReserve;
            reserveA = quote.newOtherReserve;
        }
        collateral.safeTransfer(action.user, quote.collateralOut);
        emit Trade(action.user, action.participantAOutcome, false, action.amount, quote.collateralOut);
        return (true, quote.collateralOut);
    }

    function _executeAddLiquidity(PendingAction storage action) internal returns (bool, uint256) {
        uint256 shares;
        uint256 addedA;
        uint256 addedB;

        if (totalLpShares == 0) {
            shares = action.amount;
            addedA = action.amount;
            addedB = action.amount;
        } else {
            uint256 largestReserve = Math.max(reserveA, reserveB);
            shares = Math.mulDiv(action.amount, totalLpShares, largestReserve);
            addedA = Math.mulDiv(action.amount, reserveA, largestReserve);
            addedB = Math.mulDiv(action.amount, reserveB, largestReserve);
        }

        if (shares < action.minimumReturn || shares == 0) return (false, 0);

        pendingCollateral -= action.amount;
        collateralBacking += action.amount;
        _accrueLp(action.user);
        lpSharesOf[action.user] += shares;
        totalLpShares += shares;
        lpFeeDebt[action.user] = Math.mulDiv(lpSharesOf[action.user], feePerShare, FEE_SCALE);

        reserveA += addedA;
        reserveB += addedB;
        uint256 adjustmentA = action.amount - addedA;
        uint256 adjustmentB = action.amount - addedB;
        if (adjustmentA != 0) positionAOf[action.user] += adjustmentA;
        if (adjustmentB != 0) positionBOf[action.user] += adjustmentB;

        emit LiquidityAdded(action.user, action.amount, shares, adjustmentA, adjustmentB);
        return (true, shares);
    }

    function _refund(PendingAction storage action) internal {
        action.status = ActionStatus.Refunded;
        if (action.kind == ActionKind.Buy || action.kind == ActionKind.AddLiquidity) {
            pendingCollateral -= action.amount;
            collateral.safeTransfer(action.user, action.amount);
        } else {
            _creditPosition(action.user, action.participantAOutcome, action.amount);
        }
    }

    /// @dev A fee with nobody to pay it to.
    ///
    ///      Every LP can settle their inventory once a market is final, taking
    ///      `totalLpShares` to zero. An epoch that was marked safe but never
    ///      processed can still be pushed through afterwards — the queue is
    ///      permissionless by design — and the trade inside it charges a
    ///      liquidity fee with no shares left to divide it across. That divided
    ///      by zero and panicked, on that call and every call after it, so
    ///      anything queued behind it could never be executed OR refunded.
    ///
    ///      With no shares outstanding the fee cannot be attributed to any
    ///      provider, so it stays with the market's collateral, where redemption
    ///      and settlement already account for it. Adding it to `unclaimedLpFees`
    ///      instead would strand it: those are claimed per share, and there are
    ///      no shares.
    function _distributeLpFee(uint256 fee) internal {
        if (fee == 0) return;
        if (totalLpShares == 0) {
            collateralBacking += fee;
            return;
        }
        unclaimedLpFees += fee;
        feePerShare += Math.mulDiv(fee, FEE_SCALE, totalLpShares);
    }

    function _accrueLp(address provider) internal {
        uint256 accumulated = Math.mulDiv(lpSharesOf[provider], feePerShare, FEE_SCALE);
        uint256 debt = lpFeeDebt[provider];
        if (accumulated > debt) lpFeeCredit[provider] += accumulated - debt;
        lpFeeDebt[provider] = accumulated;
    }

    function claimLpFees() external nonReentrant {
        _accrueLp(msg.sender);
        uint256 amount = lpFeeCredit[msg.sender];
        if (amount == 0) revert NothingToClaim();
        lpFeeCredit[msg.sender] = 0;
        unclaimedLpFees -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit LpFeesClaimed(msg.sender, amount);
    }

    function suspendGate(uint256 sourceSequence) external onlyRole(GATE_ROLE) {
        if (gateState != GateState.Open || sourceSequence < lastSafeSequence) revert InvalidState();
        gateState = GateState.Suspended;
        emit GateSuspended(sourceSequence);
    }

    function reopenGate(uint256 sourceSequence) external onlyRole(GATE_ROLE) {
        if (gateState != GateState.Suspended || sourceSequence <= lastSafeSequence) revert InvalidState();
        gateState = GateState.Open;
        lastSafeSequence = sourceSequence;
        emit GateReopened(sourceSequence);
    }

    function closeForDecisiveEvent(uint256 sourceSequence) external onlyRole(GATE_ROLE) {
        if (gateState == GateState.Closed || sourceSequence <= lastSafeSequence) revert InvalidState();
        gateState = GateState.Closed;
        closedAt = uint64(block.timestamp);
        closedEpoch = currentEpoch();
        decisiveSequence = sourceSequence;
        resolutionDueAt = uint64(block.timestamp + 30 minutes);
        emit ForecastingClosed(closedEpoch, sourceSequence);
    }

    function attestResult(Outcome outcome, bytes32 evidenceHash) external onlyRole(RESOLVER_ROLE) {
        if (
            gateState != GateState.Closed || provisionalOutcome != Outcome.Unset || finalOutcome != Outcome.Unset
                || block.timestamp > resolutionDueAt
        ) {
            revert InvalidState();
        }
        if (outcome == Outcome.Unset || evidenceHash == bytes32(0)) revert InvalidState();
        bytes32 key = keccak256(abi.encode(outcome, evidenceHash));
        if (resultAttestedBy[key][msg.sender]) revert DuplicateAttestation();
        resultAttestedBy[key][msg.sender] = true;
        uint8 count = ++resultAttestationCount[key];
        emit ResultAttested(msg.sender, outcome, evidenceHash, count);

        if (count == 2) {
            provisionalOutcome = outcome;
            provisionalEvidenceHash = evidenceHash;
            provisionalAt = uint64(block.timestamp);
            emit ProvisionalResultRegistered(outcome, evidenceHash, uint64(block.timestamp + challengeWindow));
        }
    }

    function challengeResult(bytes32 evidenceHash, uint256 bond) external nonReentrant {
        if (
            provisionalOutcome == Outcome.Unset || finalOutcome != Outcome.Unset || challenged
                || block.timestamp >= provisionalAt + challengeWindow || evidenceHash == bytes32(0)
                || bond != CHALLENGE_BOND
        ) revert InvalidState();
        challenged = true;
        challenger = msg.sender;
        challengeEvidenceHash = evidenceHash;
        challengeBond = bond;
        challengedAt = uint64(block.timestamp);
        collateral.safeTransferFrom(msg.sender, address(this), bond);
        emit ResultChallenged(msg.sender, evidenceHash, bond);
    }

    function attestChallengeVerdict(bool acceptChallenge) external onlyRole(RESOLVER_ROLE) nonReentrant {
        if (!challenged || finalOutcome != Outcome.Unset) revert InvalidState();
        if (challengeVerdictBy[acceptChallenge][msg.sender]) revert DuplicateAttestation();
        challengeVerdictBy[acceptChallenge][msg.sender] = true;
        uint8 count = ++challengeVerdictCount[acceptChallenge];
        emit ChallengeVerdictAttested(msg.sender, acceptChallenge, count);

        if (count == 2) {
            if (acceptChallenge) {
                _returnChallengeBond();
                _finalize(Outcome.Invalid);
            } else {
                uint256 bond = challengeBond;
                challengeBond = 0;
                collateral.safeTransfer(bondRecipient, bond);
                _finalize(provisionalOutcome);
            }
        }
    }

    function finalizeUnchallenged() external {
        if (
            provisionalOutcome == Outcome.Unset || finalOutcome != Outcome.Unset || challenged
                || block.timestamp < provisionalAt + challengeWindow
        ) revert TooEarly();
        _finalize(provisionalOutcome);
    }

    function expireChallenge() external nonReentrant {
        if (!challenged || finalOutcome != Outcome.Unset || block.timestamp < challengedAt + challengeTimeout) {
            revert TooEarly();
        }
        _returnChallengeBond();
        _finalize(Outcome.Invalid);
    }

    function invalidateUnresolved() external {
        if (
            gateState != GateState.Closed || finalOutcome != Outcome.Unset || provisionalOutcome != Outcome.Unset
                || block.timestamp < resolutionDueAt
        ) revert TooEarly();
        _finalize(Outcome.Invalid);
    }

    function _returnChallengeBond() internal {
        uint256 bond = challengeBond;
        challengeBond = 0;
        collateral.safeTransfer(challenger, bond);
    }

    function _finalize(Outcome outcome) internal {
        finalOutcome = outcome;
        emit ResultFinalized(outcome);
    }

    function redeemPositions() external nonReentrant onlyFinal {
        uint256 amountA = positionAOf[msg.sender];
        uint256 amountB = positionBOf[msg.sender];
        if (amountA == 0 && amountB == 0) revert NothingToClaim();
        positionAOf[msg.sender] = 0;
        positionBOf[msg.sender] = 0;
        uint256 payout = _resolvedValue(amountA, amountB);
        collateralBacking -= payout;
        collateral.safeTransfer(msg.sender, payout);
        emit PositionsRedeemed(msg.sender, amountA, amountB, payout);
    }

    function settleLpInventory() external nonReentrant onlyFinal {
        uint256 shares = lpSharesOf[msg.sender];
        // The share balance is the guard: settling zeroes it, so a second call
        // reverts here anyway. The flag additionally barred settlement FOREVER,
        // which stranded shares minted afterwards — an epoch marked safe but
        // processed late can execute an AddLiquidity after its provider has
        // already settled, and that collateral had no other way out.
        if (shares == 0) revert NothingToClaim();
        _accrueLp(msg.sender);
        uint256 supply = totalLpShares;
        uint256 amountA = Math.mulDiv(reserveA, shares, supply);
        uint256 amountB = Math.mulDiv(reserveB, shares, supply);
        lpInventorySettled[msg.sender] = true;
        lpSharesOf[msg.sender] = 0;
        totalLpShares = supply - shares;
        reserveA -= amountA;
        reserveB -= amountB;
        lpFeeDebt[msg.sender] = 0;
        uint256 payout = _resolvedValue(amountA, amountB);
        collateralBacking -= payout;
        collateral.safeTransfer(msg.sender, payout);
        emit LpInventorySettled(msg.sender, shares, payout);
    }

    function claimWinnerReward() external nonReentrant onlyFinal {
        uint256 payout;
        if (finalOutcome == Outcome.ParticipantA && msg.sender == rewardAddressA) {
            if (winnerRewardClaimed[msg.sender]) revert NothingToClaim();
            winnerRewardClaimed[msg.sender] = true;
            payout = winnerRewardPool;
        } else if (finalOutcome == Outcome.ParticipantB && msg.sender == rewardAddressB) {
            if (winnerRewardClaimed[msg.sender]) revert NothingToClaim();
            winnerRewardClaimed[msg.sender] = true;
            payout = winnerRewardPool;
        } else if (finalOutcome == Outcome.Tie && (msg.sender == rewardAddressA || msg.sender == rewardAddressB)) {
            if (winnerRewardClaimed[msg.sender]) revert NothingToClaim();
            address other = msg.sender == rewardAddressA ? rewardAddressB : rewardAddressA;
            winnerRewardClaimed[msg.sender] = true;
            payout = winnerRewardClaimed[other] ? winnerRewardPool : winnerRewardPool / 2;
        } else {
            revert NotEligible();
        }
        if (payout == 0) revert NothingToClaim();
        winnerRewardPool -= payout;
        collateral.safeTransfer(msg.sender, payout);
        emit WinnerRewardClaimed(msg.sender, payout);
    }

    function claimInvalidWinnerFeeRefund() external nonReentrant onlyFinal {
        if (finalOutcome != Outcome.Invalid) revert InvalidState();
        uint256 amount = winnerFeePaid[msg.sender];
        if (amount == 0) revert NothingToClaim();
        winnerFeePaid[msg.sender] = 0;
        winnerRewardPool -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit InvalidWinnerFeeRefunded(msg.sender, amount);
    }

    function claimIntegrityBond() external nonReentrant onlyFinal {
        if (readinessSource != address(0)) revert RoomManagesBonds();
        if ((msg.sender != participantA && msg.sender != participantB) || integrityBondClaimed[msg.sender]) {
            revert NotEligible();
        }
        uint256 amount = integrityBondOf[msg.sender];
        if (amount == 0) revert NothingToClaim();
        integrityBondClaimed[msg.sender] = true;
        integrityBondOf[msg.sender] = 0;
        totalIntegrityBondLiability -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit IntegrityBondClaimed(msg.sender, amount);
    }

    function _resolvedValue(uint256 amountA, uint256 amountB) internal view returns (uint256) {
        if (finalOutcome == Outcome.ParticipantA) return amountA;
        if (finalOutcome == Outcome.ParticipantB) return amountB;
        if (finalOutcome == Outcome.Tie || finalOutcome == Outcome.Invalid) return (amountA + amountB) / 2;
        return 0;
    }

    function _debitPosition(address user, bool participantAOutcome, uint256 amount) internal {
        if (participantAOutcome) positionAOf[user] -= amount;
        else positionBOf[user] -= amount;
    }

    function _creditPosition(address user, bool participantAOutcome, uint256 amount) internal {
        if (participantAOutcome) positionAOf[user] += amount;
        else positionBOf[user] += amount;
    }
}
