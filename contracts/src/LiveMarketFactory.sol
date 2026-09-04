// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {LivePredictionMarket} from "./LivePredictionMarket.sol";
import {LiveRoom} from "./LiveRoom.sol";

/// @notice Creates isolated Competition Markets and per-session LiveRooms.
/// @dev MARKET_CREATOR_ROLE is granted to LiveRoom clones, so a room market's
///      publication rules are bounded by the room contract, not an off-chain check.
contract LiveMarketFactory is AccessControl {
    bytes32 public constant MARKET_CREATOR_ROLE = keccak256("MARKET_CREATOR_ROLE");
    bytes32 public constant ROOM_CREATOR_ROLE = keccak256("ROOM_CREATOR_ROLE");

    address public immutable collateral;
    address public immutable marketImplementation;
    address public immutable roomImplementation;
    address[] private _markets;
    address[] private _rooms;
    mapping(bytes32 => address) public roomById;

    event MarketCreated(
        address indexed market,
        address indexed participantA,
        address indexed participantB,
        bytes32 roomId,
        uint32 slotIndex,
        bytes32 templateId,
        bytes32 conditionHash,
        string question,
        string streamUrl
    );
    event RoomCreated(address indexed room, bytes32 indexed roomId, address indexed publisher, address gateSigner);

    error InvalidAddress();
    error RoomIdTaken();
    error SlotAlreadyPublished();
    error NotTheRoom();
    error SaltBindingMismatch();

    constructor(address collateral_, address admin, address marketImplementation_, address roomImplementation_) {
        if (
            collateral_ == address(0) || admin == address(0) || marketImplementation_ == address(0)
                || roomImplementation_ == address(0)
        ) {
            revert InvalidAddress();
        }
        collateral = collateral_;
        marketImplementation = marketImplementation_;
        roomImplementation = roomImplementation_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_CREATOR_ROLE, admin);
        _grantRole(ROOM_CREATOR_ROLE, admin);
    }

    /// @notice Standalone market creation, preserved for non-room markets.
    function createMarket(
        LivePredictionMarket.MarketConfig calldata requestedConfig,
        address[] calldata restrictedWallets
    ) external onlyRole(MARKET_CREATOR_ROLE) returns (address market) {
        LivePredictionMarket.MarketConfig memory config = requestedConfig;
        config.collateral = collateral;
        market = Clones.clone(marketImplementation);
        _register(market, config, restrictedWallets);
    }

    /// @notice Deterministic slot creation for LiveRooms: the address of
    ///         (roomId, slotIndex) is knowable before publication.
    /// @dev Only the registered LiveRoom for `roomId` may mint its own slots,
    ///      and the config's room binding must match the deterministic salt —
    ///      MARKET_CREATOR_ROLE alone is not enough, or the factory admin could
    ///      mint a market into someone else's room.
    function createRoomMarket(
        LivePredictionMarket.MarketConfig calldata requestedConfig,
        address[] calldata restrictedWallets,
        bytes32 roomId,
        uint32 slotIndex
    ) external returns (address market) {
        if (roomById[roomId] != msg.sender) revert NotTheRoom();
        if (requestedConfig.roomId != roomId || requestedConfig.slotIndex != slotIndex) revert SaltBindingMismatch();
        LivePredictionMarket.MarketConfig memory config = requestedConfig;
        config.collateral = collateral;
        bytes32 salt = keccak256(abi.encode(roomId, slotIndex));
        address predicted = Clones.predictDeterministicAddress(marketImplementation, salt, address(this));
        if (predicted.code.length != 0) revert SlotAlreadyPublished();
        market = Clones.cloneDeterministic(marketImplementation, salt);
        _register(market, config, restrictedWallets);
    }

    function predictMarketAddress(bytes32 roomId, uint32 slotIndex) external view returns (address) {
        return Clones.predictDeterministicAddress(
            marketImplementation, keccak256(abi.encode(roomId, slotIndex)), address(this)
        );
    }

    /// @notice Creates one LiveRoom clone and grants it market creation, so the
    ///         publisher's authority is bounded by the room contract's rules.
    function createRoom(LiveRoom.RoomConfig calldata config)
        external
        onlyRole(ROOM_CREATOR_ROLE)
        returns (address room)
    {
        if (roomById[config.roomId] != address(0)) revert RoomIdTaken();
        room = Clones.clone(roomImplementation);
        roomById[config.roomId] = room;
        _rooms.push(room);
        LiveRoom(room).initialize(config);
        emit RoomCreated(room, config.roomId, config.publisher, config.gateSigner);
    }

    function _register(
        address market,
        LivePredictionMarket.MarketConfig memory config,
        address[] calldata restrictedWallets
    ) internal {
        LivePredictionMarket(market).initialize(config, restrictedWallets);
        _markets.push(market);
        emit MarketCreated(
            market,
            config.participantA,
            config.participantB,
            config.roomId,
            config.slotIndex,
            config.templateId,
            config.conditionHash,
            config.question,
            config.streamUrl
        );
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 index) external view returns (address) {
        return _markets[index];
    }

    function getMarkets() external view returns (address[] memory) {
        return _markets;
    }

    function roomCount() external view returns (uint256) {
        return _rooms.length;
    }

    function roomAt(uint256 index) external view returns (address) {
        return _rooms[index];
    }

    function getRooms() external view returns (address[] memory) {
        return _rooms;
    }
}
