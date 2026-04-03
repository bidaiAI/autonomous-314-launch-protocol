// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {LaunchTokenBase} from "./LaunchTokenBase.sol";
import {ILaunchFactoryRegistry} from "./interfaces/ILaunchFactoryRegistry.sol";

contract LaunchTokenWhitelist is LaunchTokenBase {
    using Address for address payable;
    error UnauthorizedFactoryDeployment();

    uint256 public constant WHITELIST_DURATION = 24 hours;
    uint256 public constant THRESHOLD_4_BNB = 4 ether;
    uint256 public constant THRESHOLD_6_BNB = 6 ether;
    uint256 public constant THRESHOLD_8_BNB = 8 ether;
    uint256 public constant SLOT_01_BNB = 0.1 ether;
    uint256 public constant SLOT_02_BNB = 0.2 ether;
    uint256 public constant SLOT_05_BNB = 0.5 ether;
    uint256 public constant SLOT_1_BNB = 1 ether;
    uint256 public constant MAX_SEATS = 80;

    struct ConstructorArgs {
        string name;
        string symbol;
        string metadataURI;
        address creator;
        address factory;
        address protocolFeeRecipient;
        address router;
        uint256 graduationQuoteReserve;
        uint256 whitelistThreshold;
        uint256 whitelistSlotSize;
        address[] whitelistAddresses;
    }

    uint256 public immutable whitelistDeadline;
    uint256 public immutable whitelistThreshold;
    uint256 public immutable whitelistSlotSize;
    uint256 public immutable whitelistSeatCount;
    uint256 public immutable whitelistAddressCount;

    uint256 public whitelistSeatsFilled;
    uint256 public whitelistCommittedTotal;
    uint256 public whitelistCommitVault;
    uint256 public whitelistTokensPerSeat;
    bool public whitelistFinalized;
    bool public whitelistExpiredWithoutFinalization;

    mapping(address => bool) public whitelist;
    mapping(address => bool) public whitelistSeatCommitted;
    mapping(address => bool) public whitelistAllocationClaimed;
    mapping(address => bool) public whitelistRefundClaimed;

    event WhitelistConfigured(uint256 threshold, uint256 slotSize, uint256 seatCount, uint256 whitelistCount, uint256 deadline);
    event WhitelistSeatCommitted(address indexed account, uint256 seatNumber, uint256 amount, uint256 committedTotal);
    event WhitelistFinalized(uint256 grossCommitted, uint256 netQuoteAdded, uint256 protocolFee, uint256 creatorFee, uint256 seatsFilled, uint256 tokensPerSeat, uint256 reservedTokenAmount);
    event WhitelistExpired(uint256 committedTotal, uint256 seatsFilled);
    event WhitelistRefundClaimed(address indexed account, uint256 amount);
    event WhitelistAllocationClaimed(address indexed account, uint256 tokenAmount);

    error InvalidWhitelistThreshold();
    error InvalidWhitelistSlotSize();
    error InvalidWhitelistSeatCount();
    error InvalidWhitelistAddressCount();
    error DuplicateWhitelistAddress();
    error WhitelistNotActive();
    error WhitelistSeatUnavailable();
    error WhitelistAddressNotApproved();
    error InvalidWhitelistCommitAmount();
    error WhitelistAlreadyCommitted();
    error WhitelistRefundUnavailable();
    error WhitelistAllocationUnavailable();

    constructor(ConstructorArgs memory args) LaunchTokenBase(
        args.name,
        args.symbol,
        args.metadataURI,
        args.creator,
        args.factory,
        args.protocolFeeRecipient,
        args.router,
        args.graduationQuoteReserve,
        MODE_WHITELIST_B314,
        LaunchState.WhitelistCommit
    ) {
        if (!_isAllowedThreshold(args.whitelistThreshold)) revert InvalidWhitelistThreshold();
        if (args.whitelistThreshold >= args.graduationQuoteReserve) revert InvalidWhitelistThreshold();
        if (!_isAllowedSlotSize(args.whitelistSlotSize)) revert InvalidWhitelistSlotSize();
        if (args.whitelistThreshold % args.whitelistSlotSize != 0) revert InvalidWhitelistSeatCount();

        uint256 seatCount = args.whitelistThreshold / args.whitelistSlotSize;
        if (seatCount == 0 || seatCount > MAX_SEATS) revert InvalidWhitelistSeatCount();
        if (args.whitelistAddresses.length < seatCount) revert InvalidWhitelistAddressCount();

        whitelistDeadline = block.timestamp + WHITELIST_DURATION;
        whitelistThreshold = args.whitelistThreshold;
        whitelistSlotSize = args.whitelistSlotSize;
        whitelistSeatCount = seatCount;
        whitelistAddressCount = args.whitelistAddresses.length;

        for (uint256 i = 0; i < args.whitelistAddresses.length; i++) {
            address account = args.whitelistAddresses[i];
            if (account == address(0)) revert ZeroAddress();
            if (whitelist[account]) revert DuplicateWhitelistAddress();
            whitelist[account] = true;
        }

        emit WhitelistConfigured(
            args.whitelistThreshold,
            args.whitelistSlotSize,
            seatCount,
            args.whitelistAddresses.length,
            whitelistDeadline
        );
        if (!_isAuthorizedFactoryDeployment(args.factory)) revert UnauthorizedFactoryDeployment();
    }

    receive() external payable nonReentrant {
        _advanceWhitelistPhaseIfNeeded();

        if (state == LaunchState.WhitelistCommit) {
            _commitWhitelistSeat(msg.sender);
            return;
        }
        if (state == LaunchState.Bonding314) {
            _buy(msg.sender, 0);
            return;
        }

        revert InvalidState();
    }

    function launchSuffix() external pure override returns (string memory) {
        return "b314";
    }

    function commitWhitelistSeat() external payable nonReentrant {
        _advanceWhitelistPhaseIfNeeded();
        _commitWhitelistSeat(msg.sender);
    }

    function advanceWhitelistPhase() external {
        _advanceWhitelistPhaseIfNeeded();
    }

    function claimWhitelistAllocation() external nonReentrant returns (uint256 tokenAmount) {
        if (!whitelistFinalized || !whitelistSeatCommitted[msg.sender] || whitelistAllocationClaimed[msg.sender]) {
            revert WhitelistAllocationUnavailable();
        }

        tokenAmount = whitelistTokensPerSeat;
        whitelistAllocationClaimed[msg.sender] = true;
        whitelistAllocationTokenReserve -= tokenAmount;
        lastBuyBlock[msg.sender] = block.number;
        _transfer(address(this), msg.sender, tokenAmount);

        emit WhitelistAllocationClaimed(msg.sender, tokenAmount);
    }

    function claimWhitelistRefund() external nonReentrant returns (uint256 refundAmount) {
        _advanceWhitelistPhaseIfNeeded();
        if (!whitelistExpiredWithoutFinalization || !whitelistSeatCommitted[msg.sender] || whitelistRefundClaimed[msg.sender]) {
            revert WhitelistRefundUnavailable();
        }

        refundAmount = whitelistSlotSize;
        whitelistRefundClaimed[msg.sender] = true;
        whitelistCommitVault -= refundAmount;
        payable(msg.sender).sendValue(refundAmount);

        emit WhitelistRefundClaimed(msg.sender, refundAmount);
    }

    function whitelistStatus() public view override returns (uint8) {
        if (whitelistFinalized) return WHITELIST_STATUS_FINALIZED;
        if (state == LaunchState.WhitelistCommit) {
            if (block.timestamp < whitelistDeadline) return WHITELIST_STATUS_ACTIVE;
            return WHITELIST_STATUS_EXPIRED;
        }
        if (whitelistExpiredWithoutFinalization || (state != LaunchState.WhitelistCommit && !whitelistFinalized)) {
            return WHITELIST_STATUS_EXPIRED;
        }
        return WHITELIST_STATUS_ACTIVE;
    }

    function whitelistSnapshot()
        external
        view
        override
        returns (
            uint8 status,
            uint256 deadline,
            uint256 threshold,
            uint256 slotSize,
            uint256 seatCount,
            uint256 seatsFilled,
            uint256 committedTotal,
            uint256 tokensPerSeat,
            uint256 configuredWhitelistCount
        )
    {
        return (
            whitelistStatus(),
            whitelistDeadline,
            whitelistThreshold,
            whitelistSlotSize,
            whitelistSeatCount,
            whitelistSeatsFilled,
            whitelistCommittedTotal,
            whitelistTokensPerSeat,
            whitelistAddressCount
        );
    }

    function isWhitelisted(address account) public view override returns (bool) {
        return whitelist[account];
    }

    function canCommitWhitelist(address account) external view override returns (bool) {
        return state == LaunchState.WhitelistCommit
            && block.timestamp < whitelistDeadline
            && whitelist[account]
            && !whitelistSeatCommitted[account]
            && whitelistSeatsFilled < whitelistSeatCount;
    }

    function canClaimWhitelistAllocation(address account) external view override returns (bool) {
        return whitelistFinalized && whitelistSeatCommitted[account] && !whitelistAllocationClaimed[account];
    }

    function canClaimWhitelistRefund(address account) external view override returns (bool) {
        bool expired = whitelistExpiredWithoutFinalization
            || (state == LaunchState.WhitelistCommit && block.timestamp >= whitelistDeadline && !whitelistFinalized);
        return expired && whitelistSeatCommitted[account] && !whitelistRefundClaimed[account];
    }

    function _beforeBondingAction() internal override {
        _advanceWhitelistPhaseIfNeeded();
    }

    function _additionalAccountedNative() internal view override returns (uint256) {
        return whitelistCommitVault;
    }

    function _commitWhitelistSeat(address account) internal {
        if (state != LaunchState.WhitelistCommit) revert WhitelistNotActive();
        if (block.timestamp >= whitelistDeadline) revert WhitelistNotActive();
        if (!whitelist[account]) revert WhitelistAddressNotApproved();
        if (msg.value != whitelistSlotSize) revert InvalidWhitelistCommitAmount();
        if (whitelistSeatCommitted[account]) revert WhitelistAlreadyCommitted();
        if (whitelistSeatsFilled >= whitelistSeatCount) revert WhitelistSeatUnavailable();

        whitelistSeatCommitted[account] = true;
        whitelistSeatsFilled += 1;
        whitelistCommittedTotal += msg.value;
        whitelistCommitVault += msg.value;

        emit WhitelistSeatCommitted(account, whitelistSeatsFilled, msg.value, whitelistCommittedTotal);

        if (whitelistCommittedTotal == whitelistThreshold) {
            _finalizeWhitelist();
        }
    }

    function _isAuthorizedFactoryDeployment(address factory_) private view returns (bool) {
        if (msg.sender == factory_) return true;
        if (factory_.code.length == 0) return false;
        return msg.sender == ILaunchFactoryRegistry(factory_).whitelistDeployer();
    }

    function _advanceWhitelistPhaseIfNeeded() internal {
        if (state == LaunchState.WhitelistCommit && block.timestamp >= whitelistDeadline && !whitelistFinalized) {
            if (whitelistCommittedTotal >= whitelistThreshold) {
                _finalizeWhitelist();
            } else {
                whitelistExpiredWithoutFinalization = true;
                LaunchState previousState = state;
                state = LaunchState.Bonding314;
                emit StateTransition(previousState, LaunchState.Bonding314);
                emit WhitelistExpired(whitelistCommittedTotal, whitelistSeatsFilled);
            }
        }
    }

    function _finalizeWhitelist() internal {
        if (whitelistFinalized) revert InvalidState();
        if (whitelistCommittedTotal != whitelistThreshold) revert InvalidState();

        uint256 grossCommitted = whitelistCommittedTotal;
        (uint256 totalFee, uint256 protocolFee, uint256 creatorFee) = _splitFees(grossCommitted);
        uint256 netQuoteIn = grossCommitted - totalFee;
        if (netQuoteIn == 0) revert SlippageExceeded();

        uint256 totalTokenOut = _buyTokenOut(netQuoteIn);
        uint256 tokensPerSeat = totalTokenOut / whitelistSeatCount;
        uint256 reservedTokenAmount = tokensPerSeat * whitelistSeatCount;
        if (tokensPerSeat == 0 || reservedTokenAmount == 0 || reservedTokenAmount > saleTokenReserve) revert SlippageExceeded();

        whitelistFinalized = true;
        whitelistTokensPerSeat = tokensPerSeat;
        whitelistAllocationTokenReserve = reservedTokenAmount;
        whitelistCommitVault = 0;
        curveQuoteReserve += netQuoteIn;
        protocolFeeVault += protocolFee;
        creatorFeeVault += creatorFee;
        saleTokenReserve -= reservedTokenAmount;
        lastTradeAt = block.timestamp;

        LaunchState previousState = state;
        state = LaunchState.Bonding314;
        emit StateTransition(previousState, LaunchState.Bonding314);
        emit WhitelistFinalized(grossCommitted, netQuoteIn, protocolFee, creatorFee, whitelistSeatsFilled, tokensPerSeat, reservedTokenAmount);
    }

    function _isAllowedThreshold(uint256 threshold) internal pure returns (bool) {
        return threshold == THRESHOLD_4_BNB || threshold == THRESHOLD_6_BNB || threshold == THRESHOLD_8_BNB;
    }

    function _isAllowedSlotSize(uint256 slotSize) internal pure returns (bool) {
        return slotSize == SLOT_01_BNB || slotSize == SLOT_02_BNB || slotSize == SLOT_05_BNB || slotSize == SLOT_1_BNB;
    }
}
