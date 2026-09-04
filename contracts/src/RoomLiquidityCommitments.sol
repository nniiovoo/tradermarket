// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LivePredictionMarket} from "./LivePredictionMarket.sol";
import {LiveRoom} from "./LiveRoom.sol";

/// @title RoomLiquidityCommitments
/// @notice Automates the LP's DECISION, never pools their CAPITAL. An LP grants
///         one bounded USDC approval and signs a policy; anyone may then execute
///         it against a published slot. Every draw goes straight from the LP's
///         wallet into one slot's own FPMM, and the LP Position lands on the LP.
/// @dev Money-critical: it holds LP allowances and can initiate USDC movement.
///      It holds no balance between transactions — asserted by invariant tests.
contract RoomLiquidityCommitments is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("TraderMarket RoomLiquidityCommitments");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant COMMITMENT_TYPEHASH = keccak256(
        "LiquidityCommitment(address room,address provider,bytes32[] allowedTemplates,uint256 amountPerSlot,uint256 maxSimultaneous,uint256 maxTotal,uint64 expiresAt,uint256 nonce)"
    );

    struct Commitment {
        address room;
        address provider;
        bytes32[] allowedTemplates;
        uint256 amountPerSlot;
        uint256 maxSimultaneous;
        uint256 maxTotal;
        uint64 expiresAt;
        uint256 nonce;
    }

    IERC20 public immutable collateral;

    mapping(bytes32 => mapping(address => uint256)) public executedSlot;
    mapping(bytes32 => mapping(address => bool)) public exposureReleased;
    mapping(bytes32 => uint256) public totalExecuted;
    mapping(bytes32 => uint256) public activeExposure;
    mapping(address => mapping(uint256 => bool)) public cancelledNonce;

    event CommitmentExecuted(
        bytes32 indexed commitmentId, address indexed provider, address indexed market, uint256 amount, uint256 actionId
    );
    event ExposureReleased(bytes32 indexed commitmentId, address indexed market, uint256 amount);
    event CommitmentCancelled(address indexed provider, uint256 indexed nonce);

    error InvalidSignature();
    error CommitmentExpired();
    error CommitmentCancelledError();
    error AlreadyExecuted();
    error TemplateNotAllowed();
    error ExposureExceeded();
    error TotalExceeded();
    error UnknownSlot();
    error NotSettled();
    error NothingToRelease();
    error InvalidCommitment();

    constructor(address collateral_) {
        if (collateral_ == address(0)) revert InvalidCommitment();
        collateral = IERC20(collateral_);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice One signature, one identity: re-signing the same terms with a new
    ///         nonce is a new commitment.
    function commitmentId(Commitment calldata commitment) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), _structHash(commitment)));
    }

    function _structHash(Commitment calldata commitment) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                COMMITMENT_TYPEHASH,
                commitment.room,
                commitment.provider,
                keccak256(abi.encodePacked(commitment.allowedTemplates)),
                commitment.amountPerSlot,
                commitment.maxSimultaneous,
                commitment.maxTotal,
                commitment.expiresAt,
                commitment.nonce
            )
        );
    }

    /// @notice Executes a signed commitment against one published slot. The LP's
    ///         signature is the authority; the executor earns nothing.
    function execute(Commitment calldata commitment, bytes calldata signature, address market)
        external
        nonReentrant
        returns (uint256 actionId)
    {
        bytes32 id = commitmentId(commitment);
        _validate(commitment, signature, id, market);

        uint256 amount = commitment.amountPerSlot;
        executedSlot[id][market] = amount;
        totalExecuted[id] += amount;
        activeExposure[id] += amount;

        // Straight from the LP's wallet, through this contract, into that slot's
        // FPMM. No balance is retained between transactions.
        collateral.safeTransferFrom(commitment.provider, address(this), amount);
        collateral.forceApprove(market, amount);
        actionId = LivePredictionMarket(market)
            .submitAddLiquidityFor(commitment.provider, amount, 0, uint64(block.timestamp + 1 hours));
        emit CommitmentExecuted(id, commitment.provider, market, amount, actionId);
    }

    function _validate(Commitment calldata commitment, bytes calldata signature, bytes32 id, address market)
        internal
        view
    {
        if (commitment.provider == address(0) || commitment.amountPerSlot == 0) revert InvalidCommitment();
        if (block.timestamp >= commitment.expiresAt) revert CommitmentExpired();
        if (cancelledNonce[commitment.provider][commitment.nonce]) revert CommitmentCancelledError();
        if (executedSlot[id][market] != 0) revert AlreadyExecuted();
        if (ECDSA.recover(id, signature) != commitment.provider) revert InvalidSignature();

        LiveRoom room = LiveRoom(commitment.room);
        if (!room.isSlot(market)) revert UnknownSlot();
        (,, bytes32 templateId,,) = LivePredictionMarket(market).slotBinding();
        bool allowed;
        for (uint256 i = 0; i < commitment.allowedTemplates.length; i++) {
            if (commitment.allowedTemplates[i] == templateId) {
                allowed = true;
                break;
            }
        }
        if (!allowed) revert TemplateNotAllowed();
        if (activeExposure[id] + commitment.amountPerSlot > commitment.maxSimultaneous) revert ExposureExceeded();
        if (totalExecuted[id] + commitment.amountPerSlot > commitment.maxTotal) revert TotalExceeded();
    }

    /// @notice Permissionless once the slot is Final or Invalid: restores
    ///         headroom so a commitment sized for N concurrent slots does not
    ///         die after its first N settled slots.
    function releaseExposure(Commitment calldata commitment, address market) external {
        bytes32 id = commitmentId(commitment);
        uint256 amount = executedSlot[id][market];
        if (amount == 0) revert NothingToRelease();
        if (exposureReleased[id][market]) revert NothingToRelease();
        if (LivePredictionMarket(market).finalOutcome() == LivePredictionMarket.Outcome.Unset) revert NotSettled();
        exposureReleased[id][market] = true;
        activeExposure[id] -= amount;
        emit ExposureReleased(id, market, amount);
    }

    /// @notice The LP stops future draws at any time. Positions already held are
    ///         untouched.
    function cancel(uint256 nonce) external {
        cancelledNonce[msg.sender][nonce] = true;
        emit CommitmentCancelled(msg.sender, nonce);
    }
}
