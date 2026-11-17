// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20 as OZIERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPotEscrow} from "./interfaces/IPotEscrow.sol";
import {IFeeManager} from "./interfaces/IFeeManager.sol";

/**
 * @title PlagueRooms
 * @notice Staked rooms for the Zombie Plague outbreak game, built the way plague-celo's staked rooms are:
 *         players create and join rooms from their own wallets, stakes sit in a separate custody contract
 *         (PotEscrow), fees go to a separate FeeManager, and a waiting room that never starts refunds
 *         everyone when it expires.
 *
 *         The difference is where the game runs. plague-celo plays its game on-chain; here the game is
 *         simulated by a server (the same deterministic rules the browser runs), so this contract holds no
 *         game logic at all. It knows only who staked, whether the room started, and who the server says
 *         got out. That is why it can sit behind a proxy and stay small and stable.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────────────────────────────
 *   1. A player approves this contract for the stake and calls createRoom (they are seat one) or joinRoom.
 *   2. The host calls startGame once at least two have joined. The server sees the event and plays the round.
 *   3. The server (BACKEND_ROLE) calls settle with the players who got out. Pot minus the fee is split
 *      equally among them. If nobody got out, everyone is refunded in full and no fee is taken.
 *   4. If the server never settles, any player can take their own stake back with reclaim after
 *      `reclaimAfter` seconds.
 *
 * ── What the server key can and cannot do ────────────────────────────────────────────────────────────────
 *   It can choose which of the players in a room win. It cannot pay anyone who did not stake in that room,
 *   cannot touch a waiting room, cannot take more than the fee cap, and cannot stop reclaim.
 *
 * ── Trust ────────────────────────────────────────────────────────────────────────────────────────────────
 *   The admin can upgrade this contract, and PotEscrow's admin has an emergency valve (copied from
 *   plague-celo). Both must be a multisig behind a timelock before real money goes in; say so publicly.
 */
contract PlagueRooms is Initializable, UUPSUpgradeable, AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for OZIERC20;

    bytes32 public constant BACKEND_ROLE = keccak256("BACKEND_ROLE");

    uint8 public constant MIN_PLAYERS = 2;
    uint8 public constant MAX_PLAYERS = 8;
    uint256 public constant MAX_FEE_BPS = 500;
    uint40 public constant MIN_EXPIRY = 60;
    uint40 public constant MIN_RECLAIM_AFTER = 1 hours;

    enum Status { None, Waiting, Started, Settled, Cancelled }

    struct Room {
        address host;
        Status status;
        uint8 maxPlayers;
        uint96 stake;
        uint96 pot; // what is still held for this room
        uint40 createdAt;
        uint40 expiresAt; // a waiting room refunds after this
        uint40 startedAt;
        address[] players;
    }

    // ─── Storage (append only: never reorder or remove) ──────────────────────────────────────────────────
    OZIERC20 public token;
    IPotEscrow public potEscrow;
    IFeeManager public feeManager;
    uint256 public roomCount;
    uint256 public activeRooms;
    uint256 public maxActiveRooms;
    uint96 public minStake;
    uint96 public maxStake;
    uint16 public feeBps;
    uint40 public reclaimAfter;
    mapping(uint256 roomId => Room) private _rooms;
    /// @dev What each player still has in each room (zero once paid, refunded or reclaimed).
    mapping(uint256 roomId => mapping(address player => uint96)) public stakedIn;
    /// @dev Payouts that could not be sent (the token refused the recipient). Pulled with claim().
    mapping(uint256 roomId => mapping(address player => uint256)) public owed;

    uint256[40] private __gap;

    // ─── Events ──────────────────────────────────────────────────────────────────────────────────────────
    event RoomCreated(uint256 indexed roomId, address indexed host, uint8 maxPlayers, uint96 stake, uint40 expiresAt);
    event PlayerJoined(uint256 indexed roomId, address indexed player);
    event PlayerLeft(uint256 indexed roomId, address indexed player);
    event GameStarted(uint256 indexed roomId, uint8 players);
    event RoomSettled(uint256 indexed roomId, address[] winners, uint256 share, uint256 fee, bytes32 logHash);
    event RoomRefunded(uint256 indexed roomId, string why);
    event Reclaimed(uint256 indexed roomId, address indexed player, uint96 amount);
    event PayoutOwed(uint256 indexed roomId, address indexed player, uint256 amount);
    event Claimed(uint256 indexed roomId, address indexed player, uint256 amount);
    event ConfigChanged(string what);

    // ─── Errors ──────────────────────────────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error BadPlayers();
    error BadStake();
    error BadExpiry();
    error TooManyRooms();
    error NoSuchRoom();
    error NotWaiting();
    error NotStarted();
    error Expired();
    error NotExpired();
    error RoomFull();
    error AlreadyJoined();
    error NotInRoom();
    error NotHost();
    error HostCannotLeave();
    error NotEnoughPlayers();
    error NotAWinner(address who);
    error ReclaimNotOpen();
    error NothingOwed();
    error BadConfig();
    error RoomsActive();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param admin       Gets DEFAULT_ADMIN_ROLE (config and upgrades). A multisig behind a timelock, for real money.
     * @param backend     Gets BACKEND_ROLE (settles rounds): the game server's key.
     * @param token_      The stake token (USDm on Celo).
     * @param escrow      PotEscrow whose authorizedGame is this contract's proxy.
     * @param fees        FeeManager whose authorizedGame is this contract's proxy.
     */
    function initialize(address admin, address backend, address token_, address escrow, address fees, uint96 minStake_, uint96 maxStake_) external initializer {
        if (admin == address(0) || backend == address(0) || token_ == address(0) || escrow == address(0) || fees == address(0)) revert ZeroAddress();
        if (minStake_ == 0 || maxStake_ < minStake_) revert BadConfig();
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BACKEND_ROLE, backend);
        token = OZIERC20(token_);
        potEscrow = IPotEscrow(escrow);
        feeManager = IFeeManager(fees);
        minStake = minStake_;
        maxStake = maxStake_;
        feeBps = 150; // 1.5%, as in plague-celo
        maxActiveRooms = 25;
        reclaimAfter = 6 hours;
    }

    // ─── Players ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Open a room and stake as its first player. Approve this contract for `stake` first.
    function createRoom(uint8 maxPlayers, uint96 stake, uint40 expirySecs) external whenNotPaused nonReentrant returns (uint256 roomId) {
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) revert BadPlayers();
        if (stake < minStake || stake > maxStake) revert BadStake();
        if (expirySecs < MIN_EXPIRY) revert BadExpiry();
        if (activeRooms >= maxActiveRooms) revert TooManyRooms();
        unchecked { roomId = ++roomCount; activeRooms++; }
        Room storage r = _rooms[roomId];
        r.host = msg.sender;
        r.status = Status.Waiting;
        r.maxPlayers = maxPlayers;
        r.stake = stake;
        r.createdAt = uint40(block.timestamp);
        r.expiresAt = uint40(block.timestamp) + expirySecs;
        emit RoomCreated(roomId, msg.sender, maxPlayers, stake, r.expiresAt);
        _seat(roomId, r, msg.sender);
    }

    /// @notice Join a waiting room by staking. Approve this contract for the room's stake first.
    function joinRoom(uint256 roomId) external whenNotPaused nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Waiting) revert NotWaiting();
        if (block.timestamp >= r.expiresAt) revert Expired();
        if (r.players.length >= r.maxPlayers) revert RoomFull();
        if (stakedIn[roomId][msg.sender] != 0) revert AlreadyJoined();
        _seat(roomId, r, msg.sender);
    }

    /// @notice Leave a waiting room and take your stake back. The host cannot leave (cancel the room instead).
    function leaveRoom(uint256 roomId) external nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Waiting) revert NotWaiting();
        if (msg.sender == r.host) revert HostCannotLeave();
        uint96 amount = stakedIn[roomId][msg.sender];
        if (amount == 0) revert NotInRoom();
        stakedIn[roomId][msg.sender] = 0;
        r.pot -= amount;
        _removePlayer(r, msg.sender);
        emit PlayerLeft(roomId, msg.sender);
        _pay(roomId, msg.sender, amount);
    }

    /// @notice The host closes a room that has not started and everyone is refunded.
    function cancelRoom(uint256 roomId) external nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Waiting) revert NotWaiting();
        if (msg.sender != r.host) revert NotHost();
        _refundAll(roomId, r, Status.Cancelled, "cancelled by host");
    }

    /// @notice The host closes the doors: the round is on. Needs at least two players.
    function startGame(uint256 roomId) external nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Waiting) revert NotWaiting();
        if (msg.sender != r.host) revert NotHost();
        if (block.timestamp >= r.expiresAt) revert Expired();
        if (r.players.length < MIN_PLAYERS) revert NotEnoughPlayers();
        r.status = Status.Started;
        r.startedAt = uint40(block.timestamp);
        emit GameStarted(roomId, uint8(r.players.length));
    }

    /// @notice Anyone can refund a waiting room that ran past its expiry.
    function expireRoom(uint256 roomId) external nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Waiting) revert NotWaiting();
        if (block.timestamp < r.expiresAt) revert NotExpired();
        _refundAll(roomId, r, Status.Cancelled, "expired");
    }

    /// @notice If the server never settled a started room, take your own stake back after `reclaimAfter`.
    function reclaim(uint256 roomId) external nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Started) revert NotStarted();
        if (block.timestamp < uint256(r.startedAt) + reclaimAfter) revert ReclaimNotOpen();
        uint96 amount = stakedIn[roomId][msg.sender];
        if (amount == 0) revert NotInRoom();
        stakedIn[roomId][msg.sender] = 0;
        r.pot -= amount;
        _removePlayer(r, msg.sender);
        emit Reclaimed(roomId, msg.sender, amount);
        if (r.players.length == 0) { r.status = Status.Cancelled; unchecked { activeRooms--; } }
        _pay(roomId, msg.sender, amount);
    }

    /// @notice Pull a payout that could not be sent when the room was settled.
    function claim(uint256 roomId) external nonReentrant {
        uint256 amount = owed[roomId][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[roomId][msg.sender] = 0;
        emit Claimed(roomId, msg.sender, amount);
        potEscrow.release(roomId, msg.sender, amount); // reverts (and restores `owed`) if it still cannot be sent
    }

    // ─── The server ──────────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pay out a started room. `winners` are the players who got out; each must have staked in this
     *         room and appear once. Pot minus the fee is split equally. Empty `winners` refunds everyone
     *         in full with no fee. `logHash` fingerprints the stored round log, so it can be audited.
     */
    function settle(uint256 roomId, address[] calldata winners, bytes32 logHash) external onlyRole(BACKEND_ROLE) nonReentrant {
        Room storage r = _room(roomId);
        if (r.status != Status.Started) revert NotStarted();
        if (winners.length == 0) {
            emit RoomSettled(roomId, winners, 0, 0, logHash);
            _refundAll(roomId, r, Status.Settled, "nobody got out");
            return;
        }
        uint256 pot = r.pot;
        uint256 fee = (pot * feeBps) / 10_000;
        uint256 share = (pot - fee) / winners.length;
        fee = pot - share * winners.length; // the fee, plus whatever did not divide
        // Players' stakes are accounted for now: winners are checked once each, the rest forfeit into the pot.
        for (uint256 i = 0; i < winners.length; i++) {
            if (stakedIn[roomId][winners[i]] == 0) revert NotAWinner(winners[i]);
            stakedIn[roomId][winners[i]] = 0;
        }
        address[] memory all = r.players;
        for (uint256 i = 0; i < all.length; i++) stakedIn[roomId][all[i]] = 0;
        r.status = Status.Settled;
        r.pot = 0;
        unchecked { activeRooms--; }
        emit RoomSettled(roomId, winners, share, fee, logHash);
        _takeFee(roomId, fee);
        for (uint256 i = 0; i < winners.length; i++) _pay(roomId, winners[i], share);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────────────────────────────────

    function setFeeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert BadConfig();
        feeBps = bps;
        emit ConfigChanged("feeBps");
    }

    function setStakeLimits(uint96 min_, uint96 max_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (min_ == 0 || max_ < min_) revert BadConfig();
        minStake = min_;
        maxStake = max_;
        emit ConfigChanged("stakeLimits");
    }

    function setMaxActiveRooms(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxActiveRooms = n;
        emit ConfigChanged("maxActiveRooms");
    }

    function setReclaimAfter(uint40 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (secs < MIN_RECLAIM_AFTER) revert BadConfig();
        reclaimAfter = secs;
        emit ConfigChanged("reclaimAfter");
    }

    /// @notice Point at a new custody or fee contract. Only when no room is holding money, or it would strand it.
    function setPlumbing(address escrow, address fees) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (activeRooms != 0) revert RoomsActive();
        if (escrow == address(0) || fees == address(0)) revert ZeroAddress();
        potEscrow = IPotEscrow(escrow);
        feeManager = IFeeManager(fees);
        emit ConfigChanged("plumbing");
    }

    /// @notice Stop new rooms and joins. Starting, settling, refunds and reclaim keep working.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ─── Views ───────────────────────────────────────────────────────────────────────────────────────────

    function getRoom(uint256 roomId) external view returns (
        address host, Status status, uint8 maxPlayers, uint96 stake, uint96 pot, uint40 createdAt, uint40 expiresAt, uint40 startedAt, address[] memory players
    ) {
        Room storage r = _rooms[roomId];
        return (r.host, r.status, r.maxPlayers, r.stake, r.pot, r.createdAt, r.expiresAt, r.startedAt, r.players);
    }

    // ─── Internals ───────────────────────────────────────────────────────────────────────────────────────

    function _room(uint256 roomId) private view returns (Room storage r) {
        r = _rooms[roomId];
        if (r.status == Status.None) revert NoSuchRoom();
    }

    /// @dev Take a player's stake into custody and seat them.
    function _seat(uint256 roomId, Room storage r, address player) private {
        uint96 stake = r.stake;
        token.safeTransferFrom(player, address(this), stake);
        token.forceApprove(address(potEscrow), stake);
        potEscrow.deposit(roomId, stake);
        r.players.push(player);
        r.pot += stake;
        stakedIn[roomId][player] = stake;
        emit PlayerJoined(roomId, player);
    }

    function _removePlayer(Room storage r, address player) private {
        uint256 n = r.players.length;
        for (uint256 i = 0; i < n; i++) {
            if (r.players[i] == player) {
                r.players[i] = r.players[n - 1];
                r.players.pop();
                return;
            }
        }
    }

    /// @dev Everyone gets exactly what they put in.
    function _refundAll(uint256 roomId, Room storage r, Status end, string memory why) private {
        r.status = end;
        unchecked { activeRooms--; }
        address[] memory all = r.players;
        r.pot = 0;
        for (uint256 i = 0; i < all.length; i++) {
            uint96 amount = stakedIn[roomId][all[i]];
            if (amount == 0) continue;
            stakedIn[roomId][all[i]] = 0;
            _pay(roomId, all[i], amount);
        }
        emit RoomRefunded(roomId, why);
    }

    /// @dev Send a payout. If the token refuses this recipient the amount is kept for them to claim, so one
    ///      bad recipient can never block a room.
    function _pay(uint256 roomId, address to, uint256 amount) private {
        if (amount == 0) return;
        try potEscrow.release(roomId, to, amount) {} catch {
            owed[roomId][to] += amount;
            emit PayoutOwed(roomId, to, amount);
        }
    }

    /// @dev Move the fee out of custody into the FeeManager.
    function _takeFee(uint256 roomId, uint256 fee) private {
        if (fee == 0) return;
        potEscrow.release(roomId, address(this), fee);
        token.forceApprove(address(feeManager), fee);
        feeManager.depositFee(fee);
    }
}
